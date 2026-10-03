import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { agents, type AgentRegistry, type LLMAdapter } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import { tools } from '@tnega/tools'
import { LocalSubagentService, listStoredSubagents, readSubagentEvents } from '../src/index.js'

/** 仓库既有写法：`ctx.agents` 的类型由实时 Agent 注册表提供，测试里显式取用。 */
const registryOf = (ctx: Context): AgentRegistry => (ctx as unknown as { agents: AgentRegistry }).agents

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function setup(output: string, storageRoot?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-subagent-report-'))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  const requests: (readonly ModelMessage[])[] = []
  const llm: LLMAdapter = { async complete(messages) {
    requests.push(messages)
    return { content: output, finishReason: 'stop' }
  } }
  const parent = await registryOf(root).create({ id: 'parent', file: join(cwd, 'parent.jsonl'), llm, manualStreaming: true })
  cleanup.push(() => parent.dispose())
  const service = new LocalSubagentService(root, { cwd, llm, ...(storageRoot ? { storageRoot } : {}) })
  cleanup.push(() => service.dispose())
  return { root, cwd, llm, parent: parent.agent, service, requests }
}

async function settled(service: LocalSubagentService) {
  await expect.poll(async () => (await service.list('parent'))[0]?.status).toBe('idle')
}

it('stores, lists and restores children from a storage root separate from the workspace', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'tnega-child-storage-'))
  cleanup.push(() => rm(storageRoot, { recursive: true, force: true }))
  const { cwd, service } = await setup('durable output', storageRoot)
  const child = await service.start({ parentId: 'parent', task: 'inspect' })
  await settled(service)
  expect(await stat(join(storageRoot, child.id, 'session.jsonl'))).toBeDefined()
  await expect(stat(join(cwd, '.tnega', 'subagents'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await listStoredSubagents(cwd, 'parent')).toEqual([])
  expect(await listStoredSubagents(cwd, 'parent', 'children', undefined, storageRoot)).toMatchObject([{ id: child.id, lastOutput: 'durable output' }])
  expect((await readSubagentEvents(cwd, child.id, storageRoot)).some(event => event.type === 'assistant/message')).toBe(true)
  await service.dispose()
  const { service: reopened } = await setup('durable output', storageRoot)
  expect((await reopened.readResult('parent', child.id)).output).toBe('durable output')
  await reopened.send('parent', child.id, 'continue')
  await settled(reopened)
  expect((await readSubagentEvents(cwd, child.id, storageRoot)).filter(event => event.type === 'assistant/message')).toHaveLength(2)
})

/**
 * 送进父 Agent inbox 的那份文本，就是父 Agent 唯一看得到的回报。
 *
 * inbox 消息的 `content` 按契约是模型消息；这里只承认字符串正文，测试因此不依赖内部类型。
 */
function deliveredReport(parent: { inbox: { snapshot(): { nextStep: readonly { content?: unknown }[] } } }): string {
  const content = parent.inbox.snapshot().nextStep[0]?.content
  const parts: unknown[] = Array.isArray(content) ? content : []
  return parts.map(part => part !== null && typeof part === 'object' && 'content' in part
    && typeof (part as { content: unknown }).content === 'string'
    ? (part as { content: string }).content
    : '').join('\n')
}

it('keeps long Unicode final results recoverable through bounded parent-only pages', async () => {
  const output = '🧭'.repeat(4001) + 'TAIL evidence'
  const { service, parent } = await setup(output)
  const child = await service.start({ parentId: 'parent', task: 'inspect' })
  await settled(service)
  const entry = (await service.list('parent'))[0]
  expect(entry?.resultTruncated).toBe(true)
  expect(entry?.resultChars).toBe(Array.from(output).length)
  const first = await service.readResult('parent', child.id)
  expect(first.output).toBe('🧭'.repeat(4000))
  expect(first.nextOffset).toBe(4000)
  expect(first.totalChars).toBe(Array.from(output).length)
  const tail = await service.readResult('parent', child.id, { offset: 4000 })
  expect(tail.output).toBe('🧭TAIL evidence')
  expect(tail.nextOffset).toBeNull()
  await expect(service.readResult('stranger', child.id)).rejects.toThrow('owning parent')
  const reports = parent.inbox.snapshot().nextStep
  expect(reports).toHaveLength(1)
  const report = deliveredReport(parent)
  expect(report).toContain(`Subagent ${child.id} completed: `)
  expect(report).toContain('read_subagent_result')
  // 长结果不再被静默截断：送出的开头附上限说明与续读位置，父 Agent 知道还差多少。
  expect(report).toContain(`showing 1200 of ${Array.from(output).length} characters`)
  expect(report).toContain(`"offset":1200`)
})

it('cuts a long delivered report at a line boundary and keeps the remainder reachable', async () => {
  const lines = Array.from({ length: 80 }, (_, index) => `line ${index} ${'x'.repeat(20)}`)
  const output = `${lines.join('\n')}\nSENTINEL beyond the head`
  const { service, parent } = await setup(output)
  const child = await service.start({ parentId: 'parent', task: 'inspect' })
  await settled(service)
  const report = deliveredReport(parent)
  expect(report).not.toContain('SENTINEL')
  // 送进父 Agent 上下文的部分有上限，不会把整篇答复灌进去。
  expect(Array.from(report).length).toBeLessThan(1_600)
  const marker = /showing (\d+) of (\d+) characters/.exec(report)
  expect(marker?.[2]).toBe(String(Array.from(output).length))
  const offset = Number(marker?.[1])
  expect(offset).toBeGreaterThan(0)
  // 切点正好落在换行处，续读从下一行开始，正文没有丢字。
  const chars = Array.from(output)
  expect(chars[offset]).toBe('\n')
  const rest = chars.slice(offset + 1).join('')
  expect(rest.startsWith('line ')).toBe(true)
  expect(rest.endsWith('SENTINEL beyond the head')).toBe(true)
  const page = await service.readResult('parent', child.id, { offset: offset + 1 })
  expect(page.output).toContain('SENTINEL beyond the head')
  expect(page.nextOffset).toBeNull()
})

it('persists user audience and restores its deliverable instructions on resume', async () => {
  const { root, cwd, llm, service, requests } = await setup('done')
  const child = await service.start({ parentId: 'parent', task: 'inspect', audience: 'user' })
  await settled(service)
  expect(registryOf(root).get(child.id)?.meta.subagentAudience).toBe('user')
  expect(requests[0]?.find(message => message.role === 'system')?.content).toContain('polished')
  await service.dispose()
  const nextRoot = new Context()
  await nextRoot.plugin(tools)
  await nextRoot.plugin(agents)
  const nextParent = await registryOf(nextRoot).resume({ id: 'parent', file: join(cwd, 'parent.jsonl'), llm, manualStreaming: true })
  cleanup.push(() => nextParent.dispose())
  const resumed = new LocalSubagentService(nextRoot, { cwd, llm })
  cleanup.push(() => resumed.dispose())
  await resumed.send('parent', child.id, 'continue')
  await settled(resumed)
  expect(registryOf(nextRoot).get(child.id)?.meta.subagentAudience).toBe('user')
  expect(requests.at(-1)?.find(message => message.role === 'system')?.content).toContain('polished')
  expect((await resumed.readResult('parent', child.id)).output).toBe('done')
})

it('rejects invalid audiences and paging ranges at the service boundary', async () => {
  const { service } = await setup('done')
  // Runtime callers can pass values outside the TypeScript contract.
  const invalid = JSON.parse('{"parentId":"parent","task":"inspect","audience":"public"}')
  await expect(service.start(invalid)).rejects.toThrow('audience')
  const child = await service.start({ parentId: 'parent', task: 'inspect' })
  await settled(service)
  await expect(service.readResult('parent', child.id, { offset: -1 })).rejects.toThrow('offset')
  await expect(service.readResult('parent', child.id, { limit: 16001 })).rejects.toThrow('limit')
})

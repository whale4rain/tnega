import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import { blackboardLocal } from '@tnega/blackboard-local'
import { SessionLog, session as sessionPlugin } from '@tnega/session'
import { agent, type AgentLoop, type LLMAdapter, type LLMStreamRequestEvent } from '@tnega/agent'
import { tools } from '@tnega/tools'
import { ProjectMemoryRunner, mountProjectMemory, projectMemoryAdapter } from '../src/project-memory.js'
import { normalizeProjectMemory } from '../src/config.js'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-project-memory-'))
  roots.push(directory)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(blackboardLocal, { root: join(directory, 'blackboard') })
  const session = new SessionLog(join(directory, 'source.jsonl'))
  await session.init()
  await session.append('request/header', { reason: 'initial', system: 'Original system', config: { model: 'test' }, tools: [{ name: 'shell', description: 'Run shell' }] })
  await session.append('user/message', { content: 'This release must not modify CI.' })
  await session.append('assistant/message', { content: 'This release leaves CI unchanged.' })
  await session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { directory, budgetDirectory: directory, blackboard: ctx.blackboard, session, agentId: 'thread-1' }
}

it('forks the durable prefix without mutating the Session and commits source-bound candidates once', async () => {
  const f = await fixture()
  const before = await readFile(f.session.file, 'utf8')
  const complete = vi.fn<LLMAdapter['complete']>().mockResolvedValue({ finishReason: 'stop', content: '{"memories":[{"text":"This release must not modify CI.","tags":["release"]}]}' })
  const runner = new ProjectMemoryRunner({ ...f, config: {}, resolveAdapter: () => ({ complete }) })
  expect((await runner.enqueue(f)).status).toBe('completed')
  expect((await runner.enqueue(f)).status).toBe('duplicate')
  expect(complete).toHaveBeenCalledOnce()
  expect(complete.mock.calls[0]?.[0][0]).toEqual({ role: 'system', content: 'Original system' })
  expect(complete.mock.calls[0]?.[1][0]?.schema.name).toBe('shell')
  const memory = (await f.blackboard.list('memory'))[0]
  expect(memory?.source.agentId).toBe('thread-1')
  expect(memory?.source.sessionEventId).toBeTruthy()
  expect(memory?.data).toMatchObject({ status: 'candidate', authority: 'none' })
  expect(await readFile(f.session.file, 'utf8')).toBe(before)
})

it('skips cold extraction without an explicit route and reserves failed calls across restart', async () => {
  const f = await fixture()
  const complete = vi.fn<LLMAdapter['complete']>().mockRejectedValue(new Error('network failed'))
  const options = { ...f, config: { projectMemory: { maxCallsPerDay: 1, minIntervalSeconds: 0 } }, resolveAdapter: () => ({ complete }) }
  const runner = new ProjectMemoryRunner(options)
  expect((await runner.enqueue({ ...f, trigger: 'delayed' })).reason).toBe('cold-route-missing')
  expect((await runner.enqueue(f)).status).toBe('failed')
  await f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const restarted = new ProjectMemoryRunner(options)
  expect((await restarted.enqueue(f)).reason).toBe('daily-budget')
  expect(complete).toHaveBeenCalledOnce()
})

it('rejects tool calls and oversized inputs before memory writes or extra requests', async () => {
  const f = await fixture()
  const complete = vi.fn<LLMAdapter['complete']>().mockResolvedValue({ finishReason: 'tool_calls', toolCalls: [{ id: 'a', name: 'shell', arguments: {} }] })
  const runner = new ProjectMemoryRunner({ ...f, config: {}, resolveAdapter: () => ({ complete }) })
  expect((await runner.enqueue(f)).status).toBe('failed')
  expect(await f.blackboard.list('memory')).toEqual([])
  await f.session.append('user/message', { content: 'x'.repeat(20000) })
  await f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const capped = new ProjectMemoryRunner({ ...f, config: { projectMemory: { minIntervalSeconds: 0 } }, resolveAdapter: () => ({ complete }) })
  expect((await capped.enqueue(f)).reason).toBe('input-budget')
  expect(complete).toHaveBeenCalledOnce()
})

it('shares the daily budget across Projects and never steals a held lock', async () => {
  const first = await fixture()
  const second = await fixture()
  const complete = vi.fn<LLMAdapter['complete']>().mockResolvedValue({ finishReason: 'stop', content: '{"memories":[]}' })
  const shared = { budgetDirectory: first.directory, config: { projectMemory: { maxCallsPerDay: 1, minIntervalSeconds: 0 } }, resolveAdapter: () => ({ complete }) }
  expect((await new ProjectMemoryRunner({ ...first, ...shared }).enqueue(first)).status).toBe('completed')
  expect((await new ProjectMemoryRunner({ ...second, ...shared }).enqueue(second)).reason).toBe('daily-budget')
  await writeFile(join(first.directory, 'project-memory-budget.lock'), 'unknown owner')
  const runner = new ProjectMemoryRunner({ ...second, ...shared })
  expect((await runner.enqueue(second)).reason).toBe('global-memory-busy')
  expect(complete).toHaveBeenCalledOnce()
})

it('uses the explicit cold route without tools and preserves edited or deleted automatic memories', async () => {
  const f = await fixture()
  const complete = vi.fn<LLMAdapter['complete']>().mockResolvedValue({ finishReason: 'stop', content: '{"memories":[{"text":"Scoped fact","tags":[]}]}' })
  const resolveAdapter = vi.fn(() => ({ complete }))
  const runner = new ProjectMemoryRunner({ ...f, config: { projectMemory: { coldModelId: 'cheap', minIntervalSeconds: 0 } }, resolveAdapter })
  expect((await runner.enqueue({ ...f, trigger: 'manual' })).status).toBe('completed')
  expect(resolveAdapter).toHaveBeenCalledWith('cheap', 'test')
  expect(complete.mock.calls[0]?.[1]).toEqual([])
  const memory = (await f.blackboard.list('memory'))[0]!
  await f.blackboard.commit({ kind: 'memory', id: memory.id, expectedVersion: memory.version, author: 'user', data: { text: 'Corrected fact' }, deleted: true })
  await f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect((await runner.enqueue(f)).added).toBe(0)
  expect(await f.blackboard.list('memory')).toEqual([])
})

it('fails closed for invalid limits, corrupt reservations, and unconfigured default routes', async () => {
  expect(normalizeProjectMemory({ maxCallsPerDay: -1 })).toBeUndefined()
  expect(normalizeProjectMemory({ maxInputTokens: Infinity })).toBeUndefined()
  expect(projectMemoryAdapter({})).toBeUndefined()
  const f = await fixture()
  await writeFile(join(f.directory, 'project-memory-budget.jsonl'), '{broken')
  const complete = vi.fn<LLMAdapter['complete']>()
  const runner = new ProjectMemoryRunner({ ...f, config: {}, resolveAdapter: () => ({ complete }) })
  expect((await runner.enqueue(f)).status).toBe('failed')
  expect(complete).not.toHaveBeenCalled()
})

it('cancels on disposal without committing a late model response', async () => {
  const f = await fixture()
  let started: (() => void) | undefined
  const start = new Promise<void>(resolve => { started = resolve })
  const complete: LLMAdapter['complete'] = async (_messages, _tools, options) => {
    started?.()
    await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
    return { finishReason: 'stop', content: '{"memories":[{"text":"late","tags":[]}]}' }
  }
  const runner = new ProjectMemoryRunner({ ...f, config: {}, resolveAdapter: () => ({ complete }) })
  const work = runner.enqueue(f)
  await start
  await runner.dispose()
  expect((await work).status).toBe('failed')
  expect(await f.blackboard.list('memory')).toEqual([])
  expect((await runner.enqueue(f)).reason).toBe('disposed')
})

it('rejects malformed extraction once and does not automatically retry on restart', async () => {
  const f = await fixture()
  const complete = vi.fn<LLMAdapter['complete']>().mockResolvedValue({ finishReason: 'stop', content: 'not JSON' })
  const options = { ...f, config: {}, resolveAdapter: () => ({ complete }) }
  expect((await new ProjectMemoryRunner(options).enqueue(f)).status).toBe('failed')
  expect((await new ProjectMemoryRunner(options).enqueue(f)).status).toBe('duplicate')
  expect(complete).toHaveBeenCalledOnce()
})

it('reuses the final transformed request prefix and its durable tools and temperature', async () => {
  const f = await fixture()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(sessionPlugin, { file: join(f.directory, 'transformed.jsonl') })
  await ctx.plugin(tools)
  const original = vi.fn<LLMAdapter['complete']>().mockResolvedValue({ finishReason: 'stop', content: 'Final answer' })
  await ctx.plugin(agent, { llm: { complete: original }, agentId: f.agentId })
  ctx.on('llm/stream', (payload: LLMStreamRequestEvent, next) => {
    payload.messages = [{ role: 'user', content: 'rewritten' }, { role: 'system', content: 'System in original position' }]
    payload.tools = [{ schema: { name: 'transformed_tool', description: 'Final schema' }, execute: () => undefined }]
    payload.options = { ...payload.options, model: 'transformed', temperature: 0.25 }
    return next()
  })
  const complete = vi.fn<LLMAdapter['complete']>().mockResolvedValue({ finishReason: 'stop', content: '{"memories":[]}' })
  const runner = mountProjectMemory(ctx, { ...f, config: {}, resolveAdapter: () => ({ complete }) })
  const loop: AgentLoop = ctx.get('agentLoop')
  await loop({ text: 'original user' })
  const session: SessionLog = ctx.get('session')
  await runner.enqueue({ agentId: f.agentId, session }) // Waits behind the asynchronously scheduled extraction.
  expect(complete).toHaveBeenCalledOnce()
  expect(complete.mock.calls[0]?.[0].slice(0, 2)).toEqual(original.mock.calls[0]?.[0])
  expect(complete.mock.calls[0]?.[1].map(tool => tool.schema)).toEqual(original.mock.calls[0]?.[1].map(tool => tool.schema))
  expect(complete.mock.calls[0]?.[2]).toMatchObject({ temperature: 0.25, maxTokens: 512 })
})

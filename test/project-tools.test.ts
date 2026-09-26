// 组合层测试：这里挑选 Provider、装配 Project 作用域，并端到端验证模型可见的三组工具。
// 与包内测试不同，它按仓库路径而不是包名 import —— 根目录不是一个可解析 @tnega/* 的
// workspace 包，而挑选具体 Provider 本来就是组合层的事。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agents } from '../packages/agent/src/index.js'
import { agentAddress, USER_ADDRESS } from '../packages/project/box/src/index.js'
import { Context } from '../packages/core/src/index.js'
import { tools as toolsPlugin, type ToolsService } from '../packages/tools/src/index.js'
import { blackboardLocal } from '../packages/project/blackboard-local/src/index.js'
import { artifactLocal } from '../packages/project/artifact-local/src/index.js'
import { boxBlackboard } from '../packages/project/box-blackboard/src/index.js'
import { threadLocal } from '../packages/project/thread-local/src/index.js'
import { toolBlackboard } from '../packages/project/tool-blackboard/src/index.js'
import { toolBox } from '../packages/project/tool-box/src/index.js'
import { toolThread } from '../packages/project/tool-thread/src/index.js'
import { projectLoop } from '../packages/loop/project-loop/src/index.js'

const directories: string[] = []
afterEach(async () => {
  // Windows 上文件可能还被后台写入占着，重试比让清理失败更诚实。
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })))
})

const llm = { complete: async () => ({ finishReason: 'stop' as const, content: 'noted' }) }
const project = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Notes',
  coordinatorId: '11111111-1111-4111-8111-111111111111',
  goal: 'Track findings',
}

async function mount(): Promise<{ ctx: Context; tools: ToolsService; coordinatorId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tnega-project-tools-'))
  directories.push(root)
  const ctx = new Context()
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(blackboardLocal, { root: join(root, 'blackboard') })
  await ctx.plugin(artifactLocal, { root: join(root, 'artifacts') })
  await ctx.plugin(boxBlackboard, { projectId: project.id })
  await ctx.plugin(agents)
  await ctx.plugin(threadLocal, { projectId: project.id, root, llm, permission: 'workspace-write' })
  const coordinator = await ctx.threads.ensureRoot(project)
  await ctx.plugin(toolBlackboard)
  await ctx.plugin(toolThread)
  await ctx.plugin(toolBox)
  await ctx.plugin(projectLoop, { projectId: project.id, sweepIntervalMs: 0 })
  return { ctx, tools: ctx.get('tools') as ToolsService, coordinatorId: coordinator.id }
}

async function call(
  tools: ToolsService,
  name: string,
  input: unknown,
  agentId: string,
): Promise<string> {
  const result = await tools.execute(name, input, { agentId })
  if (!result.ok) throw new Error(`${name} failed: ${result.error?.message}`)
  return String(result.output)
}

it('lets the coordinator delegate work with a card and memory with it', async () => {
  const { ctx, tools, coordinatorId } = await mount()
  try {
    const started = await call(tools, 'spawn_thread', {
      goal: 'Summarise section 2',
      expect: 'Three bullets plus the source file',
    }, coordinatorId)
    expect(started).toContain('Started thread')

    const [child] = await ctx.threads.list({ parentId: coordinatorId })
    expect(child).toMatchObject({ goal: 'Summarise section 2', depth: 1, permission: 'workspace-write' })

    const main = (await ctx.box.timeline()).filter(entry => entry.placement.kind === 'main')
    expect(main.map(entry => entry.kind)).toEqual(['dispatch'])
    expect(main[0]).toMatchObject({
      threadId: child!.id,
      recipients: [agentAddress(child!.id)],
      text: 'Summarise section 2\n\nExpected result: Three bullets plus the source file',
    })

    const listed = await call(tools, 'list_threads', {}, coordinatorId)
    expect(listed).toContain(child!.id)
    // 直接对子 Thread 下指令走同一条通道，交给 Project Loop 投递。
    await call(tools, 'send_thread_message', {
      thread_id: child!.id,
      message: 'Start with the API changes.',
      kind: 'dispatch',
    }, coordinatorId)
    // 兄弟 Thread 默认不互发控制消息：要么由父 Agent 转发，要么显式建立关系。
    const sibling = await ctx.threads.spawn({ parentId: coordinatorId, goal: 'Second thread' })
    await expect(call(tools, 'send_thread_message', {
      thread_id: sibling.id,
      message: 'hello from a sibling',
    }, child!.id)).rejects.toThrow('parent-child')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('writes project memory with conditional versions and publishes artifacts', async () => {
  const { ctx, tools, coordinatorId } = await mount()
  try {
    const saved = await call(tools, 'write_memory', { text: 'Releases ship on Thursdays' }, coordinatorId)
    const id = saved.match(/memory\/([0-9a-f-]{36})/)![1]!

    const clobber = await call(tools, 'write_memory', { id, text: 'Releases ship on Fridays' }, coordinatorId)
    expect(clobber).toContain('already exists')
    expect(clobber).toContain('Thursdays')

    const updated = await call(tools, 'write_memory', {
      id,
      text: 'Releases ship on Fridays',
      expected_version: 1,
    }, coordinatorId)
    expect(updated).toContain('v2')

    const stale = await call(tools, 'write_memory', {
      id,
      text: 'Releases ship on Mondays',
      expected_version: 1,
    }, coordinatorId)
    expect(stale).toContain('changed while you were writing')

    const read = await call(tools, 'read_project', { kind: 'memory' }, coordinatorId)
    expect(read).toContain('Fridays')

    const published = await call(tools, 'publish_artifact', {
      title: 'Section 2 summary',
      content: '# Section 2\n\n- a\n- b\n',
    }, coordinatorId)
    const hash = published.match(/hash ([0-9a-f]{64})/)![1]!
    expect(await call(tools, 'read_artifact', { hash }, coordinatorId)).toContain('# Section 2')
    expect((await ctx.blackboard.list('artifact')).map(record => record.id)).toEqual([hash])

    // 同一份内容再发布一次不会产生第二条记录。
    await call(tools, 'publish_artifact', { title: 'Section 2 summary', content: '# Section 2\n\n- a\n- b\n' }, coordinatorId)
    expect(await ctx.blackboard.list('artifact')).toHaveLength(1)

    await call(tools, 'index_resource', {
      title: 'Design doc',
      uri: 'https://example.com/design',
    }, coordinatorId)
    expect(await ctx.blackboard.list('resource')).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('lets an agent speak to the user mid-turn and records who said it', async () => {
  const { ctx, tools, coordinatorId } = await mount()
  try {
    await call(tools, 'send_project_message', { message: 'Found two conflicting numbers.' }, coordinatorId)
    const [envelope] = await ctx.box.timeline()
    expect(envelope).toMatchObject({
      kind: 'agent-reply',
      sender: agentAddress(coordinatorId),
      recipients: [USER_ADDRESS],
      placement: { kind: 'main' },
      text: 'Found two conflicting numbers.',
    })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('refuses writes without a live agent identity', async () => {
  const { ctx, tools } = await mount()
  try {
    const result = await tools.execute('write_memory', { text: 'orphan' }, {})
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('live Agent identity')
  } finally {
    await ctx.fiber.dispose()
  }
})

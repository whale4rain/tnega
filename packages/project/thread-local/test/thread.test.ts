import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agents } from '@tnega/agent'
import { Context } from '@tnega/core'
import { ThreadError } from '@tnega/thread'
import { blackboardLocal } from '../../blackboard-local/src/index.js'
import { threadLocal } from '../src/index.js'
import { tools } from '../../../tools/src/index.js'

const directories: string[] = []
afterEach(async () => {
  // Windows 上文件可能还被后台写入占着，重试比让清理失败更诚实。
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })))
})

const llm = { complete: async () => ({ finishReason: 'stop' as const, content: 'ok' }) }
const project = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Notes',
  coordinatorId: '11111111-1111-4111-8111-111111111111',
  goal: 'Track findings',
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tnega-thread-'))
  directories.push(root)
  return root
}

async function mount(root: string, sessionRoot?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin(blackboardLocal, { root: join(root, 'blackboard') })
  await ctx.plugin(agents)
  await ctx.plugin(threadLocal, {
    projectId: project.id,
    root,
    ...(sessionRoot ? { sessionRoot } : {}),
    llm,
    maxDepth: 2,
    maxChildren: 3,
    permission: 'workspace-write',
  })
  return ctx
}

it('stores and resumes Session history separately while retaining project identity data', async () => {
  const root = await workspace()
  const sessionRoot = await workspace()
  const ctx = await mount(root, sessionRoot)
  let childId: string
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Separate storage' })
    childId = child.id
    await ctx.threads.activate(child.id)
    expect(ctx.threads.sessionFile(child.id)).toBe(join(sessionRoot, 'agents', child.id, 'session.jsonl'))
    expect(existsSync(ctx.threads.sessionFile(child.id))).toBe(true)
    expect(existsSync(join(root, 'agents', child.id, 'session.jsonl'))).toBe(false)
    expect(existsSync(join(root, 'blackboard'))).toBe(true)
  } finally {
    await ctx.fiber.dispose()
  }
  const reopened = await mount(root, sessionRoot)
  try {
    expect((await reopened.threads.get(childId))?.goal).toBe('Separate storage')
    const resumed = await reopened.threads.activate(childId)
    expect((await resumed.session.read()).filter(event => event.type === 'meta' && event.payload.kind === 'agent')).toHaveLength(1)
  } finally {
    await reopened.fiber.dispose()
  }
})

it('keeps one identity folder per thread and resumes it after a restart', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  const ids: { coordinator: string; child: string } = { coordinator: '', child: '' }
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    expect(coordinator).toMatchObject({ depth: 0, state: 'idle', permission: 'workspace-write' })
    expect(coordinator.parentId).toBeUndefined()
    expect(await ctx.threads.ensureRoot(project)).toEqual(coordinator)

    const child = await ctx.threads.spawn({
      parentId: coordinator.id,
      goal: 'Summarise the release notes',
      permission: 'read-only',
    })
    // 子 Thread 的权限只能收窄。
    expect(child).toMatchObject({ depth: 1, state: 'idle', permission: 'read-only' })
    expect((await ctx.threads.list({ parentId: coordinator.id })).map(entry => entry.id))
      .toEqual([child.id])

    await ctx.threads.setState(child.id, 'working')
    expect((await ctx.threads.get(child.id))?.state).toBe('working')

    const live = await ctx.threads.activate(child.id)
    expect(live.id).toBe(child.id)
    // 同一进程里同一个 Thread 只会有一个 Agent 实例。
    expect(await ctx.threads.activate(child.id)).toBe(live)
    expect(existsSync(ctx.threads.sessionFile(child.id))).toBe(true)

    const grandchild = await ctx.threads.spawn({ parentId: child.id, goal: 'Deeper work' })
    await expect(ctx.threads.spawn({ parentId: grandchild.id, goal: 'Too deep' }))
      .rejects.toMatchObject({ code: 'THREAD_LIMIT' })
    expect((await ctx.threads.list({ parentId: coordinator.id, descendants: true }))
      .map(entry => entry.id)).toEqual([child.id, grandchild.id])

    ids.coordinator = coordinator.id
    ids.child = child.id
  } finally {
    await ctx.fiber.dispose()
  }

  const reopened = await mount(root)
  try {
    expect((await reopened.threads.get(ids.child))?.goal).toBe('Summarise the release notes')
    const resumed = await reopened.threads.activate(ids.child)
    expect(resumed.id).toBe(ids.child)
    expect(resumed.meta.parentSessionId).toBe(ids.coordinator)
    // 恢复的是同一个 Session，不是新建一个同名对话。
    expect((await resumed.session.read()).some(event => event.type === 'meta')).toBe(true)
  } finally {
    await reopened.fiber.dispose()
  }
})

it('refuses a fourth running child and ids that would escape the project folder', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'First' })
    const second = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Second' })
    const third = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Third' })
    for (const thread of [child, second, third]) {
      await ctx.threads.setState(thread.id, 'working')
    }
    await expect(ctx.threads.spawn({ parentId: coordinator.id, goal: 'Fourth' }))
      .rejects.toMatchObject({ code: 'THREAD_LIMIT' })
    // 一个结束之后又能继续委派。
    await ctx.threads.setState(child.id, 'done')
    expect(await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Fourth' })).toBeTruthy()

    await expect(ctx.threads.activate('00000000-0000-4000-8000-000000000000'))
      .rejects.toBeInstanceOf(ThreadError)
    expect(() => ctx.threads.sessionFile('../escape')).toThrow(ThreadError)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('starts a thread whose session file exists but has no agent identity yet', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Read-only glimpse' })
    // 读取一个还没跑过的 Session 会在磁盘上留下一个只有格式版本的 meta：`SessionLog`
    // 第一次读不存在的文件时会把它建出来。这样的文件不是 Agent 身份。
    await writeFile(ctx.threads.sessionFile(child.id), `${JSON.stringify({
      id: 'e6f0a3a2-3f4b-4e2c-9d5b-2f4b1c8a7d90',
      seq: 1,
      ts: Date.now(),
      type: 'meta',
      payload: { formatVersion: 10 },
    })}\n`, 'utf8')

    const live = await ctx.threads.activate(child.id)
    expect(live.meta.agentId).toBe(child.id)
    const types = (await live.session.read()).map(event => event.type)
    expect(types.filter(type => type === 'meta')).toHaveLength(2)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps a live checklist on the thread record and survives state changes', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Compare options' })
    await ctx.threads.setChecklist(child.id, [
      { title: '  Read both   options ', status: 'done' },
      { title: 'Compare trade-offs', status: 'active' },
      { title: '   ', status: 'pending' },
    ])
    await ctx.threads.setState(child.id, 'working')
    expect((await ctx.threads.get(child.id))?.checklist).toEqual([
      { title: 'Read both options', status: 'done' },
      { title: 'Compare trade-offs', status: 'active' },
    ])
    await expect(ctx.threads.setChecklist(child.id, [{ title: 'x', status: 'started' as 'active' }]))
      .rejects.toMatchObject({ code: 'THREAD_INVALID' })
    await ctx.threads.setChecklist(child.id, [])
    expect((await ctx.threads.get(child.id))?.checklist).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { BlackboardError, type FactRecord } from '@tnega/blackboard'
import { blackboardLocal } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function mount(): Promise<{ root: Context; root_dir: string }> {
  const root_dir = await mkdtemp(join(tmpdir(), 'tnega-blackboard-'))
  directories.push(root_dir)
  const root = new Context()
  await root.plugin(blackboardLocal, { root: root_dir })
  return { root, root_dir }
}

async function failure(run: () => Promise<unknown>): Promise<BlackboardError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(BlackboardError)
    return error as BlackboardError
  }
  throw new Error('expected the call to reject')
}

it('versions a record and refuses implicit last-write-wins', async () => {
  const { root } = await mount()
  try {
    const board = root.blackboard
    const first = await board.commit({
      kind: 'memory',
      id: 'memory-1',
      data: { text: 'Use pnpm' },
      author: 'user',
      expectedVersion: null,
    })
    expect(first.version).toBe(1)

    const implicit = await failure(() => board.commit({
      kind: 'memory',
      id: 'memory-1',
      data: { text: 'Use npm' },
      author: 'user',
    }))
    expect(implicit.code).toBe('BLACKBOARD_VERSION_REQUIRED')
    expect(implicit.current?.version).toBe(1)

    const stale = await failure(() => board.commit({
      kind: 'memory',
      id: 'memory-1',
      data: { text: 'Use npm' },
      author: 'user',
      expectedVersion: 7,
    }))
    expect(stale.code).toBe('BLACKBOARD_CONFLICT')
    expect(stale.current?.data).toEqual({ text: 'Use pnpm' })

    const second = await board.commit({
      kind: 'memory',
      id: 'memory-1',
      data: { text: 'Use npm' },
      author: 'user',
      expectedVersion: 1,
    })
    expect(second.version).toBe(2)
    expect((await board.read('memory', 'memory-1'))?.data).toEqual({ text: 'Use npm' })
    expect((await board.history('memory', 'memory-1')).map(entry => entry.version)).toEqual([1, 2])
  } finally {
    await root.fiber.dispose()
  }
})

it('applies a batch atomically or not at all', async () => {
  const { root, root_dir } = await mount()
  try {
    const board = root.blackboard
    await board.commit({
      kind: 'message',
      id: 'message-1',
      data: { text: 'first' },
      author: 'user',
      expectedVersion: null,
    })

    const rejected = await failure(() => board.commitAll([
      {
        kind: 'message',
        id: 'message-2',
        data: { text: 'second' },
        author: 'user',
        expectedVersion: null,
      },
      {
        kind: 'delivery',
        id: 'message-1:agent',
        data: { status: 'pending' },
        author: 'box',
        expectedVersion: null,
      },
      // 这一条与已有记录冲突，整批都必须不落盘。
      { kind: 'message', id: 'message-1', data: {}, author: 'user', expectedVersion: null },
    ]))
    expect(rejected.code).toBe('BLACKBOARD_CONFLICT')
    expect(await board.read('message', 'message-2')).toBeUndefined()
    expect(await board.read('delivery', 'message-1:agent')).toBeUndefined()

    const applied = await board.commitAll([
      {
        kind: 'message',
        id: 'message-2',
        data: { text: 'second' },
        author: 'user',
        expectedVersion: null,
      },
      {
        kind: 'delivery',
        id: 'message-1:agent',
        data: { status: 'pending' },
        author: 'box',
        expectedVersion: null,
      },
    ])
    expect(applied.map(record => record.seq)).toEqual([2, 3])

    // 重新加载同一目录：内存折叠出来的状态必须与落盘内容一致。
    const reopened = new Context()
    await reopened.plugin(blackboardLocal, { root: root_dir })
    try {
      const listed = await reopened.blackboard.list('message')
      expect(listed.map(record => record.id)).toEqual(['message-1', 'message-2'])
      const next = await reopened.blackboard.commit({
        kind: 'message',
        id: 'message-3',
        data: { text: 'third' },
        author: 'user',
        expectedVersion: null,
      })
      expect(next.seq).toBe(4)
    } finally {
      await reopened.fiber.dispose()
    }
  } finally {
    await root.fiber.dispose()
  }
})

it('deletes as a new version, restores the same way, and cursors by seq', async () => {
  const { root } = await mount()
  try {
    const board = root.blackboard
    for (const id of ['a', 'b', 'c']) {
      await board.commit({ kind: 'resource', id, data: { id }, author: 'user', expectedVersion: null })
    }
    expect((await board.list('resource')).map(record => record.id)).toEqual(['a', 'b', 'c'])

    const deleted = await board.commit({
      kind: 'resource',
      id: 'a',
      data: { id: 'a' },
      author: 'user',
      expectedVersion: 1,
      deleted: true,
    })
    expect(deleted.version).toBe(2)
    expect((await board.read('resource', 'a'))?.deleted).toBe(true)
    expect((await board.list('resource')).map(record => record.id)).toEqual(['b', 'c'])
    expect((await board.list('resource', { includeDeleted: true })).map(record => record.id))
      .toEqual(['b', 'c', 'a'])

    const restored = await board.commit({
      kind: 'resource',
      id: 'a',
      data: { id: 'a' },
      author: 'user',
      expectedVersion: 2,
    })
    expect(restored.version).toBe(3)
    expect((await board.list('resource')).map(record => record.id)).toEqual(['b', 'c', 'a'])

    // 游标按当前版本的 seq 推进：`after` 之前提交过的 b 已经不在窗口里。
    expect((await board.list('resource', { after: 2 })).map(record => record.id)).toEqual(['c', 'a'])
    expect(await board.list('resource', { after: 5 })).toEqual([])
  } finally {
    await root.fiber.dispose()
  }
})

it('notifies committed records to observers without letting them change the result', async () => {
  const { root } = await mount()
  try {
    const seen: FactRecord[] = []
    root.on('blackboard/commit', (event: { records: readonly FactRecord[] }) => {
      seen.push(...event.records)
      throw new Error('observers must not change the committed fact')
    })
    const record = await root.blackboard.commit({
      kind: 'decision',
      id: 'decision-1',
      data: { text: 'Ship v2' },
      author: 'agent:root',
      expectedVersion: null,
    })
    expect(record.version).toBe(1)
    expect(seen.map(entry => entry.id)).toEqual(['decision-1'])
  } finally {
    await root.fiber.dispose()
  }
})

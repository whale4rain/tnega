import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import { BlackboardError, type FactRecord } from '@tnega/blackboard'
import { blackboardLocal } from '../src/index.js'

// Keep the real filesystem, with replaceable exports only for write-failure injection.
vi.mock('node:fs/promises', async (importOriginal: () => Promise<typeof import('node:fs/promises')>) => ({
  ...await importOriginal(),
}))

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  // Windows 上文件可能还被后台写入占着，重试比让清理失败更诚实。
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })))
})

it.each([false, true])('recovers an interrupted append when rollback fails: %s', async (rollbackFails: boolean) => {
  const { root, root_dir } = await mount()
  const file = join(root_dir, 'journal.jsonl')
  await root.blackboard.commit({ kind: 'memory', id: 'before', data: '中文', author: 'user' })
  const prefix = await readFile(file)
  const append = fs.appendFile
  vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (path: Parameters<typeof appendFile>[0]) => {
    await append(path, '{"type":"blackboard/transaction",')
    throw new Error('interrupted append')
  })
  if (rollbackFails) vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('rollback unavailable'))
  try {
    await expect(root.blackboard.commitAll([
      { kind: 'message', id: 'envelope', data: 'hello', author: 'user' },
      { kind: 'delivery', id: 'recipient', data: 'pending', author: 'box' },
    ])).rejects.toMatchObject({ code: 'BLACKBOARD_FAILED' })
    vi.restoreAllMocks()
    if (rollbackFails) {
      const failedBytes = await readFile(file)
      await expect(root.blackboard.commit({ kind: 'memory', id: 'blocked', data: {}, author: 'user' }))
        .rejects.toMatchObject({ code: 'BLACKBOARD_FAILED' })
      expect(await readFile(file)).toEqual(failedBytes)
    } else {
      expect(await readFile(file)).toEqual(prefix)
      expect(await root.blackboard.read('message', 'envelope')).toBeUndefined()
      expect((await root.blackboard.commit({ kind: 'memory', id: 'retry', data: {}, author: 'user' })).seq).toBe(2)
    }
  } finally {
    await root.fiber.dispose()
  }
  const recovered = await reopen(root_dir)
  try {
    expect(await recovered.blackboard.read('message', 'envelope')).toBeUndefined()
    expect(await recovered.blackboard.read('delivery', 'recipient')).toBeUndefined()
    expect((await recovered.blackboard.read('memory', 'before'))?.data).toBe('中文')
    await recovered.blackboard.commit({ kind: 'memory', id: 'after', data: 'saved', author: 'user' })
  } finally {
    await recovered.fiber.dispose()
  }
  const restarted = await reopen(root_dir)
  try {
    expect((await restarted.blackboard.read('memory', 'after'))?.data).toBe('saved')
  } finally {
    await restarted.fiber.dispose()
  }
})

async function reopen(root_dir: string): Promise<Context> {
  const root = new Context()
  await root.plugin(blackboardLocal, { root: root_dir })
  return root
}

it('repairs a torn UTF-8 tail before appending subsequent commits', async () => {
  const { root, root_dir } = await mount()
  await root.blackboard.commit({ kind: 'memory', id: 'before', data: '中文', author: 'user' })
  await root.fiber.dispose()
  const file = join(root_dir, 'journal.jsonl')
  const prefix = await readFile(file)
  await appendFile(file, Buffer.from('{"data":"中').subarray(0, -1))
  const recovered = await reopen(root_dir)
  try {
    expect((await recovered.blackboard.read('memory', 'before'))?.data).toBe('中文')
    await recovered.blackboard.commit({ kind: 'memory', id: 'after', data: 'saved', author: 'user' })
  } finally {
    await recovered.fiber.dispose()
  }
  expect((await readFile(file)).subarray(0, prefix.length)).toEqual(prefix)
  const restarted = await reopen(root_dir)
  try {
    expect((await restarted.blackboard.read('memory', 'after'))?.data).toBe('saved')
    expect((await restarted.blackboard.read('memory', 'before'))?.data).toBe('中文')
  } finally {
    await restarted.fiber.dispose()
  }
})

it('recovers a batch wholly or not across transaction and UTF-8 boundaries', async () => {
  const { root, root_dir } = await mount()
  await root.blackboard.commit({ kind: 'memory', id: 'before', data: '中文', author: 'user' })
  const file = join(root_dir, 'journal.jsonl')
  const prefix = await readFile(file)
  await root.blackboard.commitAll([
    { kind: 'message', id: 'envelope', data: '你好', author: 'user' },
    { kind: 'delivery', id: 'recipient', data: 'pending', author: 'box' },
  ])
  await root.fiber.dispose()
  const complete = await readFile(file)
  const messageStart = complete.indexOf('"kind":"message"', prefix.length)
  const deliveryStart = complete.indexOf('"kind":"delivery"', prefix.length)
  const unicode = complete.indexOf(Buffer.from('你好'), prefix.length)
  expect(messageStart).toBeGreaterThan(prefix.length)
  expect(deliveryStart).toBeGreaterThan(messageStart)
  expect(unicode).toBeGreaterThan(messageStart)
  // Exercise each structural failure and every byte of the multibyte value,
  // without repeating hundreds of identical fsync/reopen cycles per test run.
  const boundaries = new Set([prefix.length, prefix.length + 1, messageStart, deliveryStart - 1,
    deliveryStart, ...Array.from({ length: Buffer.byteLength('你好') }, (_, index) => unicode + index),
    complete.length - 2, complete.length - 1, complete.length])
  for (const end of boundaries) {
    await writeFile(file, complete.subarray(0, end))
    const recovered = await reopen(root_dir)
    try {
      const message = await recovered.blackboard.read('message', 'envelope')
      const delivery = await recovered.blackboard.read('delivery', 'recipient')
      expect(Boolean(message), `message at byte ${end}`).toBe(end === complete.length)
      expect(Boolean(delivery), `delivery at byte ${end}`).toBe(end === complete.length)
      const next = await recovered.blackboard.commit({ kind: 'memory', id: 'after', data: 'saved', author: 'user' })
      expect(next.seq).toBe(end === complete.length ? 4 : 2)
    } finally {
      await recovered.fiber.dispose()
    }
    const restarted = await reopen(root_dir)
    try {
      expect((await restarted.blackboard.read('memory', 'before'))?.data).toBe('中文')
      expect((await restarted.blackboard.read('memory', 'after'))?.data).toBe('saved')
    } finally {
      await restarted.fiber.dispose()
    }
  }
})

it('loads legacy records without a final newline and preserves later commits', async () => {
  const { root, root_dir } = await mount()
  const legacy = await root.blackboard.commit({ kind: 'memory', id: 'legacy', data: '旧格式', author: 'user' })
  await root.fiber.dispose()
  await writeFile(join(root_dir, 'journal.jsonl'), JSON.stringify(legacy))
  const recovered = await reopen(root_dir)
  try {
    expect(await recovered.blackboard.read('memory', 'legacy')).toEqual(legacy)
    await recovered.blackboard.commit({ kind: 'memory', id: 'new', data: 'new', author: 'user' })
  } finally {
    await recovered.fiber.dispose()
  }
  const restarted = await reopen(root_dir)
  try {
    expect(await restarted.blackboard.read('memory', 'legacy')).toEqual(legacy)
    expect((await restarted.blackboard.read('memory', 'new'))?.seq).toBe(2)
  } finally {
    await restarted.fiber.dispose()
  }
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

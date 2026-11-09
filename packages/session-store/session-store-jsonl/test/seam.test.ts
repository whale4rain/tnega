import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog, sessionLockPath, type SessionEvent } from '@tnega/session'
import { SessionLeaseError } from '@tnega/session-store'
import { JsonlSessionStore, sessionFile, sessionStoreJsonl } from '../src/index.js'

const dirs: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-store-seam-'))
  dirs.push(workspace)
  const ctx = new Context()
  const mounted = await ctx.plugin(sessionStoreJsonl)
  cleanups.push(() => mounted.dispose())
  const store = ctx.get('sessionStore')
  const { id } = await store.create(workspace, { title: 'Seam' })
  return { store, workspace, id }
}

function message(seq: number, content: string, id: string = randomUUID()): SessionEvent {
  return { id, seq, ts: 1_700_000_000_000 + seq, type: 'user/message', payload: { content } }
}

async function all(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('the JSONL session store', () => {
  it('reads back exactly the events it appended', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    const batch = [message(2, 'one'), message(3, 'two')]
    expect(await store.append(workspace, id, { expectedSeq: 1, events: batch, owner: 'runtime-a' })).toEqual({ status: 'committed', seqs: [2, 3] })
    const read = await all(store.read(workspace, id))
    expect(read.slice(1)).toEqual(batch)
    expect(await all(store.read(workspace, id, 2))).toEqual([batch[1]])
    // A SessionLog opened on the same log sees the same events.
    const log = SessionLog.readOnly(store.backend(workspace, id))
    expect((await log.read()).slice(1)).toEqual(batch)
  })

  it('answers a retried batch with the stored seqs, and refuses a changed or partial one', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    const first = message(2, 'one')
    const second = message(3, 'two')
    await store.append(workspace, id, { expectedSeq: 1, events: [first, second], owner: 'runtime-a' })

    // The same batch again, keys in another order: a retry after a lost answer.
    const reordered: SessionEvent = { payload: { content: 'one' }, type: 'user/message', ts: first.ts, seq: 2, id: first.id }
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [reordered, second], owner: 'runtime-a' })).toEqual({ status: 'committed', seqs: [2, 3] })
    // Same id, other contents.
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'changed', first.id)], owner: 'runtime-a' })).toEqual({ status: 'conflict', headSeq: 3 })
    // Part stored, part new: all or nothing.
    expect(await store.append(workspace, id, { expectedSeq: 3, events: [second, message(4, 'three')], owner: 'runtime-a' })).toEqual({ status: 'conflict', headSeq: 3 })
    expect(await all(store.read(workspace, id))).toHaveLength(3)
  })

  it('refuses an append that does not follow the head, and stores nothing', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    expect(await store.append(workspace, id, { expectedSeq: 5, events: [message(6, 'late')], owner: 'runtime-a' })).toEqual({ status: 'conflict', headSeq: 1 })
    await expect(store.append(workspace, id, { expectedSeq: 1, events: [message(7, 'gap')], owner: 'runtime-a' })).rejects.toThrow(/expected 2/)
    expect(await all(store.read(workspace, id))).toHaveLength(1)
  })

  it('counts events a live writer in this process has not written out yet', async () => {
    const { store, workspace, id } = await setup()
    const log = new SessionLog(sessionFile(workspace, id))
    await log.init()
    try {
      // Not awaited: the event is committed in memory before it is written.
      void log.append('user/message', { content: 'still in memory' })
      expect((await store.summary(workspace, id)).eventCount).toBe(2)
      void log.append('user/message', { content: 'and another' })
      expect((await store.list(workspace)).map(summary => summary.eventCount)).toEqual([3])
    } finally { await log.close() }
  })

  it('patches permission and approvals with the metadata, and stores nothing for what is already in force', async () => {
    const { store, workspace, id } = await setup()
    const patched = await store.patchMeta(workspace, id, { title: 'Renamed', permission: 'workspace-write', approvalMode: 'auto' })
    expect(patched).toMatchObject({ title: 'Renamed', permission: 'workspace-write', approvalMode: 'auto', eventCount: 4 })
    // A retry of the whole patch stores nothing new.
    expect((await store.patchMeta(workspace, id, { title: 'Renamed', permission: 'workspace-write', approvalMode: 'auto' })).eventCount).toBe(4)
  })

  it('forks a Session through a message, and rewinds one to before a message', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    const first = message(2, 'first')
    const second = message(3, 'second')
    await store.append(workspace, id, { expectedSeq: 1, events: [first, second], owner: 'runtime-a' })
    const fork = await store.fork(workspace, id, { messageId: first.id })
    expect(fork).toMatchObject({ parentSessionId: id, forkedAtMessageId: first.id, title: 'Seam fork' })
    expect((await all(store.read(workspace, fork.id))).filter(event => event.type === 'user/message').map(event => event.id)).toEqual([first.id])
    const rewound = await store.rewind(workspace, id, second.id)
    expect(rewound.eventCount).toBe(2)
    expect((await all(store.read(workspace, id))).map(event => event.seq)).toEqual([1, 2])
  })

  it('finds Sessions by message text, counting what a live writer still holds', async () => {
    const { store, workspace, id } = await setup()
    const log = SessionLog.live(store.backend(workspace, id)) ?? new SessionLog(store.backend(workspace, id))
    await log.init()
    try {
      void log.append('user/message', { content: 'Where is the Parser config?' })
      expect(await store.search(workspace, 'parser CONFIG')).toEqual([{ id, snippet: 'Where is the Parser config?' }])
      expect(await store.search(workspace, 'nothing like this')).toEqual([])
    } finally { await log.close() }
  })

  it('lets one writer append at a time', async () => {
    const { store, workspace, id } = await setup()
    await expect(store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'x')], owner: 'runtime-a' })).rejects.toBeInstanceOf(SessionLeaseError)
    const lease = await store.lease(workspace, id, 'runtime-a')
    expect(await store.lease(workspace, id, 'runtime-a')).toMatchObject({ owner: 'runtime-a' })
    await expect(store.lease(workspace, id, 'runtime-b')).rejects.toMatchObject({ holder: 'runtime-a' })
    await expect(store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'x')], owner: 'runtime-b' })).rejects.toBeInstanceOf(SessionLeaseError)
    await lease.release()
    await store.lease(workspace, id, 'runtime-b')
  })

  it('gives one lease to one of two owners asking at once', async () => {
    const { store, workspace, id } = await setup()
    const asks = await Promise.allSettled([store.lease(workspace, id, 'runtime-a'), store.lease(workspace, id, 'runtime-b')])
    expect(asks.map(ask => ask.status)).toEqual(['fulfilled', 'rejected'])
    const [won] = asks
    if (won?.status !== 'fulfilled') throw new Error('the first ask should win')
    await won.value.release()
    // Released fully: nothing of the lost ask stays behind in the lock.
    const lease = await store.lease(workspace, id, 'runtime-b')
    await lease.release()
  })

  it('cuts a torn last line before appending, so no event is swallowed', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    await appendFile(sessionFile(workspace, id), '{"id":"half","seq":2,"ty')
    const next = message(2, 'after the crash')
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [next], owner: 'runtime-a' })).toEqual({ status: 'committed', seqs: [2] })
    expect((await all(store.read(workspace, id))).at(-1)).toEqual(next)
    expect(await readFile(sessionFile(workspace, id), 'utf8')).not.toContain('half')
  })

  it('lets an append under way finish before its lease lets go of the lock', async () => {
    const { store, workspace, id } = await setup()
    const lease = await store.lease(workspace, id, 'runtime-a')
    let settled = false
    const pending = store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'in flight')], owner: 'runtime-a' })
    void pending.then(() => { settled = true }, () => { settled = true })
    // Past the lease check and into reading the log.
    await new Promise(done => setImmediate(done))
    expect(settled).toBe(false)
    await lease.release()
    expect(settled).toBe(true)
    expect(await pending).toEqual({ status: 'committed', seqs: [2] })
  })

  it('takes over a lease another process stopped renewing 30 seconds ago', async () => {
    const { store, workspace, id } = await setup()
    const lock = sessionLockPath(sessionFile(workspace, id))
    await writeFile(lock, JSON.stringify({ pid: 4242, host: 'another-machine', token: 'theirs' }))
    await expect(store.lease(workspace, id, 'runtime-a')).rejects.toThrow(/another-machine/)
    const stale = new Date(Date.now() - 31_000)
    await utimes(lock, stale, stale)
    const lease = await store.lease(workspace, id, 'runtime-a')
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'mine now')], owner: 'runtime-a' })).toMatchObject({ status: 'committed' })
    await lease.release()
  })

  it('does not lease a session that is open for writing in this process', async () => {
    const { store, workspace, id } = await setup()
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    await log.append('user/message', { content: 'live' })
    await expect(store.lease(workspace, id, 'runtime-a')).rejects.toBeInstanceOf(SessionLeaseError)
    // The live log's events are read through the store all the same.
    expect((await all(store.read(workspace, id))).map(event => event.type)).toEqual(['meta', 'user/message'])
    await log.close()
  })

  it('waits for a release already under way before it is disposed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tnega-store-seam-'))
    dirs.push(workspace)
    const ctx = new Context()
    const mounted = await ctx.plugin(sessionStoreJsonl)
    const store = ctx.get('sessionStore')
    const { id } = await store.create(workspace)
    const lease = await store.lease(workspace, id, 'runtime-a')
    const releasing = lease.release()
    await mounted.dispose()
    // Disposed means the lock file is gone, not that it soon will be.
    await expect(readFile(sessionLockPath(sessionFile(workspace, id)), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await releasing
  })

  it('releases its leases when the plugin is disposed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tnega-store-seam-'))
    dirs.push(workspace)
    const ctx = new Context()
    const mounted = await ctx.plugin(sessionStoreJsonl)
    const { id } = await ctx.get('sessionStore').create(workspace)
    await ctx.get('sessionStore').lease(workspace, id, 'runtime-a')
    // A lease asked for while the plugin goes away is refused, not left holding the lock.
    const late = ctx.get('sessionStore')
    const { id: second } = await late.create(workspace)
    await mounted.dispose()
    await expect(late.lease(workspace, second, 'runtime-a')).rejects.toBeInstanceOf(SessionLeaseError)
    expect(ctx.get('sessionStore', false)).toBeUndefined()
    const other = new Context()
    new JsonlSessionStore(other)
    await other.get('sessionStore').lease(workspace, id, 'runtime-b')
    await other.get('sessionStore').delete(workspace, id)
  })
})

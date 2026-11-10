import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog, renderToolResult, type SessionEvent } from '@tnega/session'
import { SessionLeaseError, type SessionStore } from '@tnega/session-store'
import { sessionStoreJsonl } from '@tnega/session-store-jsonl'
import { blobsLocal } from '@tnega/blobs-local'
import { sessionStorePg, type SessionStorePgConfig } from '../src/index.js'

let db: PGlite
const cleanups: Array<() => Promise<void>> = []
const dirs: string[] = []

beforeAll(async () => {
  db = new PGlite()
  await db.waitReady
})
afterAll(async () => {
  await db.close()
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function mount(config: Partial<SessionStorePgConfig> = {}): Promise<{ store: SessionStore; ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const mounted = await ctx.plugin(sessionStorePg, { sql: db, ...config })
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await mounted.dispose()
  }
  cleanups.push(dispose)
  return { store: ctx.get('sessionStore'), ctx, dispose }
}

async function setup(config: Partial<SessionStorePgConfig> = {}) {
  const { store, dispose } = await mount(config)
  // A folder path, as a local host names workspaces.
  const workspace = join(tmpdir(), `tnega-pg-${randomUUID()}`)
  const { id } = await store.create(workspace, { title: 'Seam' })
  return { store, workspace, id, dispose }
}

function message(seq: number, content: string, id: string = randomUUID()): SessionEvent {
  return { id, seq, ts: 1_700_000_000_000 + seq, type: 'user/message', payload: { content } }
}

async function all(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('the Postgres session store', () => {
  it('reads back exactly the events it appended', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    const batch = [message(2, 'one'), message(3, 'two')]
    expect(await store.append(workspace, id, { expectedSeq: 1, events: batch, owner: 'runtime-a' })).toEqual({ status: 'committed', seqs: [2, 3] })
    const read = await all(store.read(workspace, id))
    expect(read.slice(1)).toEqual(batch)
    expect(await all(store.read(workspace, id, 2))).toEqual([batch[1]])
    const log = SessionLog.readOnly(store.backend(workspace, id))
    expect((await log.read()).slice(1)).toEqual(batch)
    expect(await store.summary(workspace, id)).toMatchObject({ id, title: 'Seam', workspace, eventCount: 3 })
  })

  it('answers a retried batch with the stored seqs, and refuses a changed or partial one', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    const first = message(2, 'one')
    const second = message(3, 'two')
    await store.append(workspace, id, { expectedSeq: 1, events: [first, second], owner: 'runtime-a' })
    const reordered: SessionEvent = { payload: { content: 'one' }, type: 'user/message', ts: first.ts, seq: 2, id: first.id }
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [reordered, second], owner: 'runtime-a' })).toEqual({ status: 'committed', seqs: [2, 3] })
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'changed', first.id)], owner: 'runtime-a' })).toEqual({ status: 'conflict', headSeq: 3 })
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

  it('keeps two concurrent appends from interleaving: one commits, the other is a conflict', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    const results = await Promise.all([
      store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'a')], owner: 'runtime-a' }),
      store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'b')], owner: 'runtime-a' }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['committed', 'conflict'])
    expect(await all(store.read(workspace, id))).toHaveLength(2)
  })

  it('lists, summarises and finds Sessions per workspace, newest first', async () => {
    const { store, workspace, id } = await setup()
    const other = await store.create(workspace, { title: 'Second' })
    await store.lease(workspace, other.id, 'runtime-a')
    await store.append(workspace, other.id, { expectedSeq: 1, events: [message(2, 'Where is the Parser config?')], owner: 'runtime-a' })
    expect((await store.list(workspace)).map(summary => [summary.title, summary.eventCount])).toEqual([['Second', 2], ['Seam', 1]])
    expect(await store.search(workspace, 'parser CONFIG')).toEqual([{ id: other.id, snippet: 'Where is the Parser config?' }])
    expect(await store.list(join(tmpdir(), 'tnega-pg-nobody'))).toEqual([])
    // A Session is only found in its own workspace.
    expect((await store.summary(join(tmpdir(), 'tnega-pg-nobody'), id)).eventCount).toBe(0)
    await expect(all(store.read(join(tmpdir(), 'tnega-pg-nobody'), id))).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('counts events a live writer in this process has not written out yet', async () => {
    const { store, workspace, id } = await setup()
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    try {
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
    expect((await store.patchMeta(workspace, id, { title: 'Renamed', permission: 'workspace-write', approvalMode: 'auto' })).eventCount).toBe(4)
    // The row's folded meta follows, for readers of the table.
    const { rows } = await db.query<{ title: string }>(`select meta->>'title' as title from session where id = $1`, [id])
    expect(rows[0]?.title).toBe('Renamed')
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
    // The head follows the rewind, so the next append goes on at seq 3.
    expect(await store.append(workspace, id, { expectedSeq: 2, events: [message(3, 'again')], owner: 'runtime-a' })).toMatchObject({ status: 'committed' })
  })

  it('lets one writer append at a time', async () => {
    const { store, workspace, id } = await setup()
    await expect(store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'x')], owner: 'runtime-a' })).rejects.toBeInstanceOf(SessionLeaseError)
    const lease = await store.lease(workspace, id, 'runtime-a')
    expect(await store.lease(workspace, id, 'runtime-a')).toMatchObject({ owner: 'runtime-a' })
    await expect(store.lease(workspace, id, 'runtime-b')).rejects.toMatchObject({ holder: 'runtime-a' })
    await expect(store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'x')], owner: 'runtime-b' })).rejects.toBeInstanceOf(SessionLeaseError)
    await lease.release()
    await (await store.lease(workspace, id, 'runtime-b')).release()
  })

  it('gives a Session to one of two servers on one database, and to the other once the lease lapses', async () => {
    const { store: first, workspace, id } = await setup({ leaseMs: 300, renewMs: 60_000 })
    const { store: second } = await mount({ leaseMs: 300, renewMs: 60_000 })
    await first.lease(workspace, id, 'server-a')
    await expect(second.lease(workspace, id, 'server-b')).rejects.toMatchObject({ holder: 'server-a' })
    // Nobody renews (the first server froze): the lease can be taken after it lapses.
    await new Promise(done => setTimeout(done, 400))
    await second.lease(workspace, id, 'server-b')
    expect(await second.append(workspace, id, { expectedSeq: 1, events: [message(2, 'mine now')], owner: 'server-b' })).toMatchObject({ status: 'committed' })
    // The frozen server wakes up: it is fenced out by the row, not by trust.
    await expect(first.append(workspace, id, { expectedSeq: 2, events: [message(3, 'stale')], owner: 'server-a' })).rejects.toBeInstanceOf(SessionLeaseError)
  })

  it('renews a held lease so it does not lapse while the writer lives', async () => {
    const { store, workspace, id } = await setup({ leaseMs: 300, renewMs: 50 })
    const { store: other } = await mount({ leaseMs: 300 })
    await store.lease(workspace, id, 'server-a')
    await new Promise(done => setTimeout(done, 500))
    await expect(other.lease(workspace, id, 'server-b')).rejects.toBeInstanceOf(SessionLeaseError)
  })

  it('takes over at once the lease of an earlier process on this machine', async () => {
    const { store, workspace, id } = await setup()
    // What a server killed mid-run leaves behind: its pid (reused here) with another process instance.
    await db.query(
      `update session set lease_owner = $2, lease_until = now() + interval '30 seconds' where id = $1`,
      [id, `tnega/${hostname()}/${process.pid}/${randomUUID()}/${randomUUID()}`],
    )
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    await log.append('user/message', { content: 'after the restart' })
    await log.flush()
    await log.close()
    expect((await all(store.read(workspace, id))).map(event => event.type)).toEqual(['meta', 'user/message'])
    // A writer on another machine keeps its lease until it lapses.
    await db.query(
      `update session set lease_owner = $2, lease_until = now() + interval '30 seconds' where id = $1`,
      [id, `tnega/another-machine/4242/${randomUUID()}/${randomUUID()}`],
    )
    const blocked = new SessionLog(store.backend(workspace, id))
    await blocked.init()
    await expect(blocked.append('user/message', { content: 'no' })).rejects.toThrow(/4242 on another-machine/)
  })

  it('runs a SessionLog on the rows: a writer, a reader, and a new Session from its first event', async () => {
    const { store, workspace } = await setup()
    const id = randomUUID()
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    await log.append('user/message', { content: 'hello' })
    await log.append('tool/call', { id: 'call-1', name: 'shell', arguments: { command: 'ls' } })
    await log.flush()
    await log.close()
    expect((await store.summary(workspace, id)).eventCount).toBe(3)
    // The call never got its result: the next writer closes it, after the log.
    const next = new SessionLog(store.backend(workspace, id))
    await next.init()
    const events = await next.read()
    await next.close()
    expect(events.at(-1)?.type).toBe('tool/result')
    expect((await all(store.read(workspace, id))).at(-1)?.type).toBe('tool/result')
  })

  it('does not lease a session that is open for writing in this process', async () => {
    const { store, workspace, id } = await setup()
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    await log.append('user/message', { content: 'live' })
    await expect(store.lease(workspace, id, 'runtime-a')).rejects.toBeInstanceOf(SessionLeaseError)
    expect((await all(store.read(workspace, id))).map(event => event.type)).toEqual(['meta', 'user/message'])
    await log.close()
    await (await store.lease(workspace, id, 'runtime-a')).release()
  })

  it('keeps a NUL in a tool output as U+FFFD instead of failing the append', async () => {
    const { store, workspace, id } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [message(2, 'a\u0000b')], owner: 'runtime-a' })).toMatchObject({ status: 'committed' })
    const last = (await all(store.read(workspace, id))).at(-1)
    expect(last?.type === 'user/message' && last.payload.content).toBe('a�b')
  })

  it('releases its leases when the plugin is disposed', async () => {
    const { store, workspace, id, dispose } = await setup()
    await store.lease(workspace, id, 'runtime-a')
    await dispose()
    await expect(store.lease(workspace, id, 'runtime-b')).rejects.toBeInstanceOf(SessionLeaseError)
    const { store: other } = await mount()
    await (await other.lease(workspace, id, 'runtime-b')).release()
  })

  it('deletes a Session with its events', async () => {
    const { store, workspace, id } = await setup()
    await store.delete(workspace, id)
    expect(await store.list(workspace)).toEqual([])
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from session_event where session_id = $1`, [id])
    expect(rows[0]?.n).toBe(0)
  })

  it('keeps images as blobs and gives them back inline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tnega-pg-blobs-'))
    dirs.push(home)
    const ctx = new Context()
    const blobs = await ctx.plugin(blobsLocal, { root: home })
    const mounted = await ctx.plugin(sessionStorePg, { sql: db })
    cleanups.push(async () => { await mounted.dispose(); await blobs.dispose() })
    const store = ctx.get('sessionStore')
    const workspace = join(tmpdir(), `tnega-pg-${randomUUID()}`)
    const { id } = await store.create(workspace)
    await store.lease(workspace, id, 'runtime-a')
    const data = Buffer.from('not really a png').toString('base64')
    const event: SessionEvent = { id: randomUUID(), seq: 2, ts: 2, type: 'user/message', payload: { content: 'look', attachments: [{ type: 'image', mediaType: 'image/png', data }] } }
    await store.append(workspace, id, { expectedSeq: 1, events: [event], owner: 'runtime-a' })
    const { rows } = await db.query<{ data: string }>(`select event->'payload'->'attachments'->0->>'data' as data from session_event where session_id = $1 and seq = 2`, [id])
    expect(rows[0]?.data).toBe('')
    expect((await all(store.read(workspace, id))).at(-1)).toEqual(event)
  })

  it('folds the same snapshot as the JSONL store for the same events', async () => {
    const { store, workspace, id } = await setup()
    const home = await mkdtemp(join(tmpdir(), 'tnega-pg-jsonl-'))
    dirs.push(home)
    const jsonlCtx = new Context()
    const jsonl = await jsonlCtx.plugin(sessionStoreJsonl)
    cleanups.push(() => jsonl.dispose())
    const local = jsonlCtx.get('sessionStore')
    const localSession = await local.create(home, { title: 'Seam' })
    const events: SessionEvent[] = [
      { id: randomUUID(), seq: 2, ts: 2, type: 'turn/start', payload: { turn: 1 } },
      message(3, 'run ls'),
      { id: randomUUID(), seq: 4, ts: 4, type: 'tool/call', payload: { id: 'c1', name: 'shell', arguments: { command: 'ls' } } },
      { id: randomUUID(), seq: 5, ts: 5, type: 'tool/result', payload: { id: 'r1', toolCallId: 'c1', name: 'shell', ok: true, output: { stdout: 'a\nb\n', exitCode: 0 } } },
    ]
    const pgLease = await store.lease(workspace, id, 'runtime-a')
    const localLease = await local.lease(home, localSession.id, 'runtime-a')
    await store.append(workspace, id, { expectedSeq: 1, events, owner: 'runtime-a' })
    await local.append(home, localSession.id, { expectedSeq: 1, events, owner: 'runtime-a' })
    // Nobody writes any more: both readers close the open turn the same way.
    await pgLease.release()
    await localLease.release()
    const fromPg = await store.snapshot(workspace, id)
    const fromJsonl = await local.snapshot(home, localSession.id)
    // Closers get fresh ids; everything else is the same event.
    const strip = (snapshot: typeof fromPg) => snapshot.events.filter(event => event.type !== 'meta').map(event => events.some(given => given.id === event.id) ? event : { ...event, id: 'closer' })
    expect(strip(fromPg)).toEqual(strip(fromJsonl))
    expect(fromPg.context).toEqual(fromJsonl.context)
    expect(fromPg.metrics).toEqual(fromJsonl.metrics)
    const resultOf = (snapshot: typeof fromPg) => snapshot.log.find(event => event.type === 'tool/result')
    const pgResult = resultOf(fromPg)
    const jsonlResult = resultOf(fromJsonl)
    if (pgResult?.type !== 'tool/result' || jsonlResult?.type !== 'tool/result') throw new Error('a tool result was stored')
    expect(renderToolResult(pgResult.payload)).toBe(renderToolResult(jsonlResult.payload))
  })
})

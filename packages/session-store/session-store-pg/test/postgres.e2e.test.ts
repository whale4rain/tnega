import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog, type SessionEvent } from '@tnega/session'
import type { SessionStore } from '@tnega/session-store'
import { sessionStorePg } from '../src/index.js'

/**
 * Host layer: a real Postgres. Point TNEGA_TEST_DATABASE_URL at a database
 * this test may fill (each run uses its own schema, dropped afterwards).
 */
const url = process.env.TNEGA_TEST_DATABASE_URL
const schema = `tnega_e2e_${randomUUID().replaceAll('-', '')}`
const urlWithSchema = url ? `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}` : ''
const disposers: Array<() => Promise<void>> = []

async function mount(): Promise<SessionStore> {
  const ctx = new Context()
  const mounted = await ctx.plugin(sessionStorePg, { url: urlWithSchema })
  disposers.push(() => mounted.dispose())
  return ctx.get('sessionStore')
}

async function all(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe.skipIf(!url)('the Postgres session store on a real database', () => {
  let admin: pg.Client
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url })
    await admin.connect()
    await admin.query(`create schema ${schema}`)
  })
  afterAll(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  })

  it('works on a database seeded from the server plan, and bootstraps over it without change', async () => {
    const plan = await readFile(resolve(import.meta.dirname, '../../../../docs/plans/v2-server-mvp.md'), 'utf8')
    const section = plan.slice(plan.indexOf('### 3.2'))
    const seed = section.slice(section.indexOf('```sql') + 6, section.indexOf('```', section.indexOf('```sql') + 6))
    const seeded = `${schema}_seeded`
    await admin.query(`create schema ${seeded}`)
    try {
      await admin.query(`set search_path = ${seeded}; ${seed}`)
      await admin.query(`set search_path = public`)
      const ctx = new Context()
      const mounted = await ctx.plugin(sessionStorePg, { url: `${url}${url?.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${seeded}`)}` })
      try {
        const store = ctx.get('sessionStore')
        const workspace = join(tmpdir(), `tnega-seeded-${randomUUID()}`)
        const { id } = await store.create(workspace, { title: 'Seeded' })
        expect((await store.list(workspace)).map(summary => summary.title)).toEqual(['Seeded'])
        const { rows } = await admin.query(`select count(*)::int as n from ${seeded}.session where id = $1`, [id])
        expect(rows[0].n).toBe(1)
      } finally {
        await mounted.dispose()
      }
    } finally {
      await admin.query(`drop schema ${seeded} cascade`)
    }
  })

  it('reads a 1,000-event Session back in order', async () => {
    const store = await mount()
    const workspace = join(tmpdir(), `tnega-long-${randomUUID()}`)
    const { id } = await store.create(workspace)
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    for (let index = 0; index < 999; index += 1) {
      void log.append(index % 2 ? 'assistant/message' : 'user/message', { content: `message ${index}` })
    }
    await log.flush()
    await log.close()
    const events = await all(store.read(workspace, id))
    expect(events).toHaveLength(1000)
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1))
    expect((await store.summary(workspace, id)).eventCount).toBe(1000)
  })

  it('lets only one of two servers on one database hold a Session, and fences the other out', async () => {
    const first = await mount()
    const second = await mount()
    const workspace = join(tmpdir(), `tnega-two-${randomUUID()}`)
    const { id } = await first.create(workspace)
    const asks = await Promise.allSettled([first.lease(workspace, id, 'server-a'), second.lease(workspace, id, 'server-b')])
    expect(asks.map(ask => ask.status).sort()).toEqual(['fulfilled', 'rejected'])
    const winner = asks[0]?.status === 'fulfilled' ? { store: first, owner: 'server-a' } : { store: second, owner: 'server-b' }
    const loser = winner.store === first ? { store: second, owner: 'server-b' } : { store: first, owner: 'server-a' }
    const event: SessionEvent = { id: randomUUID(), seq: 2, ts: Date.now(), type: 'user/message', payload: { content: 'hi' } }
    await expect(loser.store.append(workspace, id, { expectedSeq: 1, events: [event], owner: loser.owner })).rejects.toMatchObject({ code: 'SESSION_LEASED' })
    expect(await winner.store.append(workspace, id, { expectedSeq: 1, events: [event], owner: winner.owner })).toEqual({ status: 'committed', seqs: [2] })
  })

  it('continues a Session at once after the process writing it was killed', async () => {
    const store = await mount()
    const workspace = join(tmpdir(), `tnega-killed-${randomUUID()}`)
    const { id } = await store.create(workspace)
    // A writer process on this machine takes the lease and keeps renewing it, as a server mid-run would.
    const child = spawn(process.execPath, ['-e', `
      const { Client } = require(${JSON.stringify(createRequire(import.meta.url).resolve('pg'))})
      const client = new Client({ connectionString: ${JSON.stringify(urlWithSchema)} })
      client.connect().then(async () => {
        const owner = 'tnega/' + ${JSON.stringify(hostname())} + '/' + process.pid + '/instance/store'
        const take = () => client.query("update session set lease_owner = $2, lease_until = now() + interval '30 seconds' where id = $1", [${JSON.stringify(id)}, owner])
        await take()
        console.log('held')
        setInterval(take, 1000)
      })
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((done, fail) => {
      child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('held')) done() })
      child.once('exit', code => fail(new Error(`writer exited early (${code})`)))
    })
    const blocked = new SessionLog(store.backend(workspace, id))
    await blocked.init()
    await expect(blocked.append('user/message', { content: 'while it runs' })).rejects.toThrow(/being written by another process/)
    await blocked.close().catch(() => undefined)
    child.kill('SIGKILL')
    await new Promise(done => child.once('exit', done))
    // No 30-second wait: the holder was a process of this machine and it is gone.
    const started = Date.now()
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    await log.append('user/message', { content: 'after the kill' })
    await log.flush()
    await log.close()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((await all(store.read(workspace, id))).at(-1)).toMatchObject({ type: 'user/message', payload: { content: 'after the kill' } })
  })
})

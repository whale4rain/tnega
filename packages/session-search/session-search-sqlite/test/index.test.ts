import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionLog } from '@tnega/session'
import { createSession, readSessionEventsReadOnly, sessionFile } from '@tnega/session-store'
import { SqliteSessionIndex } from '../src/index.js'

let root: string
let previousHome: string | undefined
let alpha: string
let beta: string
let index: SqliteSessionIndex
let clock: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tnega-session-index-'))
  previousHome = process.env.TNEGA_HOME
  process.env.TNEGA_HOME = join(root, 'home')
  alpha = join(root, 'alpha')
  beta = join(root, 'beta')
  await mkdir(alpha, { recursive: true })
  await mkdir(beta, { recursive: true })
  clock = 1_000_000_000
  index = new SqliteSessionIndex({ now: () => clock })
})

afterEach(async () => {
  await index.close()
  if (previousHome === undefined) delete process.env.TNEGA_HOME
  else process.env.TNEGA_HOME = previousHome
  await rm(root, { recursive: true, force: true })
})

async function seed(workspace: string, title: string, messages: string[]): Promise<string> {
  const session = await createSession(workspace, { title })
  const log = new SessionLog(sessionFile(workspace, session.id))
  await log.init()
  for (const [position, content] of messages.entries()) {
    if (position % 2 === 0) await log.append('user/message', { content })
    else await log.append('assistant/message', { content })
  }
  await log.close()
  return session.id
}

it('keeps its database in the tnega home', async () => {
  expect(index.path).toBe(join(root, 'home', 'session-index.sqlite'))
})

it('ranks sessions with more matches first and leaves out the asking session', async () => {
  const once = await seed(alpha, 'One mention', ['the installer icon', 'ok'])
  const often = await seed(beta, 'Installer work', ['installer fails', 'rebuild the installer', 'installer works now'])
  const asking = await seed(alpha, 'Asking', ['find the installer'])
  const result = await index.searchSessions({ query: 'INSTALLER', workspaces: [alpha, beta], excludeSessionId: asking, limit: 10 })
  expect(result.sessions.map(session => session.sessionId)).toEqual([often, once])
  expect(result.sessions[0]).toMatchObject({ workspace: beta, title: 'Installer work', matches: 4 })
  expect(result.sessions[0]!.snippet).toContain('**')
  expect(result.capped).toBe(false)
})

it('finds short Chinese words and every word of a query', async () => {
  const id = await seed(alpha, '主题', ['透明模式下窗口控件不跟随主题', '好的'])
  await seed(alpha, 'Other', ['窗口 only'])
  const short = await index.searchSessions({ query: '控件', workspaces: [alpha], limit: 10 })
  expect(short.sessions.map(session => session.sessionId)).toEqual([id])
  expect(short.sessions[0]!.snippet).toContain('**控件**')
  const both = await index.searchSessions({ query: '窗口 透明模式', workspaces: [alpha], limit: 10 })
  expect(both.sessions.map(session => session.sessionId)).toEqual([id])
})

it('only searches the workspaces it is given and treats query syntax as text', async () => {
  await seed(beta, 'Hidden', ['secret plan'])
  expect((await index.searchSessions({ query: 'secret', workspaces: [alpha], limit: 10 })).sessions).toEqual([])
  await expect(index.searchSessions({ query: '"secret OR NEAR(', workspaces: [beta], limit: 10 })).resolves.toMatchObject({ sessions: [] })
})

it('picks up appended messages and rewound sessions on the next search', async () => {
  const id = await seed(alpha, 'Growing', ['first message'])
  expect((await index.searchSessions({ query: 'second', workspaces: [alpha], limit: 10 })).sessions).toEqual([])
  const log = new SessionLog(sessionFile(alpha, id))
  await log.init()
  await log.append('assistant/message', { content: 'second message' })
  await log.close()
  expect((await index.searchSessions({ query: 'second', workspaces: [alpha], limit: 10 })).sessions).toHaveLength(1)
  // A rewind rewrites the file shorter: the index forgets what is gone.
  const events = await readSessionEventsReadOnly(alpha, id)
  await writeFile(sessionFile(alpha, id), `${events.filter(event => event.type !== 'assistant/message').map(event => JSON.stringify(event)).join('\n')}\n`)
  expect((await index.searchSessions({ query: 'second', workspaces: [alpha], limit: 10 })).sessions).toEqual([])
  expect((await index.searchSessions({ query: 'first', workspaces: [alpha], limit: 10 })).sessions).toHaveLength(1)
})

it('searches inside one session and reads around a match', async () => {
  const id = await seed(alpha, 'Long', Array.from({ length: 9 }, (_, position) => position === 4 ? 'the needle is here' : `message ${position}`))
  const found = await index.searchEvents({ session: { workspace: alpha, sessionId: id }, query: 'needle', limit: 5 })
  expect(found).toMatchObject({ title: 'Long', total: 1, hits: [{ kind: 'user' }] })
  const seq = found.hits[0]!.seq
  const read = await index.read({ session: { workspace: alpha, sessionId: id }, around: seq, limit: 3 })
  expect(read.entries.map(entry => entry.text)).toEqual(['message 3', 'the needle is here', 'message 5'])
  expect(read.earlierBefore).toBe(read.entries[0]!.seq)
  expect(read.laterAround).toBeGreaterThan(seq)
  const back = await index.read({ session: { workspace: alpha, sessionId: id }, before: read.earlierBefore!, limit: 2 })
  expect(back.entries.map(entry => entry.text)).toEqual(['message 1', 'message 2'])
  await expect(index.read({ session: { workspace: beta, sessionId: id }, limit: 3 })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
})

it('drops the sessions used least when it grows past its size, and indexes a dropped one again when it is named', async () => {
  await index.close()
  const big = 'x'.repeat(2_000)
  index = new SqliteSessionIndex({ now: () => clock, maxChars: 5_500, keepUsedWithinMs: 1_000 })
  const used = await seed(alpha, 'Used', [`${big} alpha`])
  const unused = await seed(alpha, 'Unused', [`${big} beta`])
  // Read the first one often; the other is never touched.
  for (let time = 0; time < 3; time += 1) await index.read({ session: { workspace: alpha, sessionId: used }, limit: 1 })
  clock += 10_000
  await seed(alpha, 'Newer', [`${big} gamma`])
  const result = await index.searchSessions({ query: 'xxx', workspaces: [alpha], limit: 10 })
  expect(result.sessions.map(session => session.title)).not.toContain('Unused')
  expect(result.sessions.map(session => session.title)).toContain('Used')
  expect(await index.stats()).toMatchObject({ sessions: 3, evicted: 1 })
  expect((await index.stats()).chars).toBeLessThanOrEqual(5_500)

  // Unchanged, a dropped session stays out of the index on later searches.
  await index.searchSessions({ query: 'xxx', workspaces: [alpha], limit: 10 })
  expect(await index.stats()).toMatchObject({ evicted: 1 })
  // Naming it (the user pasted its link) indexes it again.
  const named = await index.searchEvents({ session: { workspace: alpha, sessionId: unused }, query: 'beta', limit: 5 })
  expect(named.total).toBe(1)
})

it('forgets sessions whose files are gone', async () => {
  const id = await seed(alpha, 'Doomed', ['delete me'])
  expect((await index.searchSessions({ query: 'delete', workspaces: [alpha], limit: 10 })).sessions).toHaveLength(1)
  await rm(sessionFile(alpha, id))
  expect((await index.searchSessions({ query: 'delete', workspaces: [alpha], limit: 10 })).sessions).toEqual([])
  expect(await index.stats()).toMatchObject({ sessions: 0 })
})

it('locates a session by id among workspaces', async () => {
  const id = await seed(beta, 'Somewhere', ['hi'])
  expect(await index.locate(id, [alpha, beta])).toEqual({ workspace: beta, sessionId: id })
  expect(await index.locate(id, [alpha])).toBeUndefined()
  expect(await index.locate('../escape', [alpha, beta])).toBeUndefined()
})

it('skips a damaged line without failing the search', async () => {
  const id = await seed(alpha, 'Damaged', ['still searchable'])
  await appendFile(sessionFile(alpha, id), '{not json\n')
  expect((await index.searchSessions({ query: 'searchable', workspaces: [alpha], limit: 10 })).sessions).toHaveLength(1)
})

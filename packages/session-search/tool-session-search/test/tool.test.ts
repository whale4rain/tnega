import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { formatSessionLink } from '@tnega/session-search'
import { SqliteSessionIndex, sessionSearchSqlite } from '@tnega/session-search-sqlite'
import { createSession, sessionFile } from '@tnega/session-store'
import { tools, type ToolsService } from '@tnega/tools'
import { SESSION_TOOL_NAMES, toolSessionSearch } from '../src/index.js'

let root: string
let previousHome: string | undefined
let alpha: string
let beta: string
let index: SqliteSessionIndex

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tnega-session-tools-'))
  previousHome = process.env.TNEGA_HOME
  process.env.TNEGA_HOME = join(root, 'home')
  alpha = join(root, 'alpha')
  beta = join(root, 'beta')
  await mkdir(alpha, { recursive: true })
  await mkdir(beta, { recursive: true })
  index = new SqliteSessionIndex()
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

async function mount(workspaces: string[]): Promise<{ registry: ToolsService; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(tools)
  const provider = ctx.plugin(sessionSearchSqlite, { index })
  await provider
  const consumer = ctx.plugin(toolSessionSearch({ workspaces: () => workspaces }))
  await consumer
  return {
    registry: ctx.get('tools'),
    dispose: async () => { await consumer.dispose(); await provider.dispose() },
  }
}

function output(result: unknown): Record<string, unknown> {
  expect(result).toMatchObject({ ok: true })
  const value = result && typeof result === 'object' && 'output' in result ? result.output : undefined
  expect(value).toBeTypeOf('object')
  return Object.fromEntries(Object.entries(value ?? {}))
}

it('searches every known workspace and leaves out the calling session', async () => {
  const other = await seed(beta, 'Installer icons', ['make the installer icon white'])
  const caller = await seed(alpha, 'Now', ['search for installer'])
  const { registry, dispose } = await mount([alpha, beta])
  try {
    const found = output(await registry.execute('search_sessions', { query: 'installer' }, { agentId: caller }))
    expect(found.sessions).toEqual([expect.objectContaining({ session: other, workspace: beta, title: 'Installer icons', matches: 2 })])
    const scoped = output(await registry.execute('search_sessions', { query: 'installer', workspace: alpha }, { agentId: caller }))
    expect(scoped.sessions).toEqual([])
  } finally { await dispose() }
})

it('takes a pasted session link or a bare id', async () => {
  const id = await seed(beta, 'Theme bug', ['window controls ignore the theme', 'fixed in glass mode'])
  const { registry, dispose } = await mount([alpha, beta])
  try {
    const byLink = output(await registry.execute('search_session', { session: formatSessionLink({ workspace: beta, sessionId: id }), query: 'glass' }))
    expect(byLink).toMatchObject({ session: id, workspace: beta, title: 'Theme bug', total: 1, hits: [{ kind: 'assistant' }] })
    const seq = Array.isArray(byLink.hits) ? Number(byLink.hits[0].seq) : 0
    const read = output(await registry.execute('read_session', { session: id, around: seq, limit: 1 }))
    expect(read).toMatchObject({ session: id, entries: [{ kind: 'assistant', text: 'fixed in glass mode' }] })
  } finally { await dispose() }
})

it('refuses sessions outside the known workspaces', async () => {
  const hidden = await seed(beta, 'Hidden', ['secret'])
  const { registry, dispose } = await mount([alpha])
  try {
    await expect(registry.execute('search_sessions', { query: 'secret', workspace: beta })).resolves.toMatchObject({ ok: false })
    await expect(registry.execute('read_session', { session: formatSessionLink({ workspace: beta, sessionId: hidden }) })).resolves.toMatchObject({ ok: false })
    await expect(registry.execute('read_session', { session: hidden })).resolves.toMatchObject({ ok: false })
  } finally { await dispose() }
})

it('removes its tools on disposal', async () => {
  const { registry, dispose } = await mount([alpha])
  expect(registry.list().map(tool => tool.schema.name)).toEqual(expect.arrayContaining([...SESSION_TOOL_NAMES]))
  await dispose()
  expect(registry.list().some(tool => SESSION_TOOL_NAMES.some(name => name === tool.schema.name))).toBe(false)
})

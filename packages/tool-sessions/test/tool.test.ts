import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { createSession, sessionFile } from '@tnega/session-store'
import { tools, type ToolsService } from '@tnega/tools'
import { toolSessions } from '../src/index.js'

let root: string
let previousHome: string | undefined
let alpha: string
let beta: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tnega-session-tools-'))
  previousHome = process.env.TNEGA_HOME
  process.env.TNEGA_HOME = join(root, 'home')
  alpha = join(root, 'alpha')
  beta = join(root, 'beta')
  await mkdir(alpha, { recursive: true })
  await mkdir(beta, { recursive: true })
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.TNEGA_HOME
  else process.env.TNEGA_HOME = previousHome
  await rm(root, { recursive: true, force: true })
})

async function seed(workspace: string, title: string, messages: Array<['user' | 'assistant', string]>): Promise<string> {
  const session = await createSession(workspace, { title })
  const log = new SessionLog(sessionFile(workspace, session.id))
  await log.init()
  for (const [role, content] of messages) {
    if (role === 'user') await log.append('user/message', { content })
    else await log.append('assistant/message', { content })
  }
  await log.close()
  return session.id
}

async function mount(workspaces: string[]): Promise<{ registry: ToolsService; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(tools)
  const fiber = ctx.plugin(toolSessions({ workspaces: () => workspaces }))
  await fiber
  return { registry: ctx.get('tools'), dispose: () => fiber.dispose() }
}

it('finds sessions in other workspaces by message text and by title', async () => {
  const fromAlpha = await seed(alpha, 'Release notes', [['user', 'How do we ship the Windows installer?'], ['assistant', 'Run the release workflow.']])
  const fromBeta = await seed(beta, 'Installer icons', [['user', 'Make the icon white']])
  await seed(beta, 'Unrelated', [['user', 'hello']])
  const { registry, dispose } = await mount([alpha, beta])
  try {
    const result = await registry.execute('search_sessions', { query: 'INSTALLER' })
    expect(result).toMatchObject({ ok: true, output: { searchedWorkspaces: 2 } })
    const sessions = result.ok ? (result.output as { sessions: Array<Record<string, unknown>> }).sessions : []
    expect(sessions).toHaveLength(2)
    expect(sessions).toContainEqual(expect.objectContaining({
      workspace: alpha, sessionId: fromAlpha, title: 'Release notes', matched: 'message',
      snippet: expect.stringContaining('Windows installer'),
    }))
    expect(sessions).toContainEqual(expect.objectContaining({ workspace: beta, sessionId: fromBeta, matched: 'title' }))

    const scoped = await registry.execute('search_sessions', { query: 'installer', workspace: beta })
    expect(scoped).toMatchObject({ ok: true, output: { searchedWorkspaces: 1, sessions: [{ sessionId: fromBeta }] } })
  } finally { await dispose() }
})

it('refuses a workspace the app does not list', async () => {
  const { registry, dispose } = await mount([alpha])
  try {
    await expect(registry.execute('search_sessions', { query: 'x', workspace: beta })).resolves.toMatchObject({ ok: false })
    const id = await seed(beta, 'Hidden', [['user', 'secret']])
    await expect(registry.execute('read_session', { workspace: beta, sessionId: id })).resolves.toMatchObject({ ok: false })
  } finally { await dispose() }
})

it('reads a session from another workspace, newest messages first page, and pages back', async () => {
  const id = await seed(beta, 'Long chat', Array.from({ length: 5 }, (_, index): ['user' | 'assistant', string] => [index % 2 === 0 ? 'user' : 'assistant', `message ${index}`]))
  const { registry, dispose } = await mount([alpha, beta])
  try {
    const latest = await registry.execute('read_session', { workspace: beta, sessionId: id, maxMessages: 2 })
    expect(latest).toMatchObject({
      ok: true,
      output: {
        title: 'Long chat', totalMessages: 5,
        messages: [{ index: 3, role: 'assistant', content: 'message 3' }, { index: 4, role: 'user', content: 'message 4' }],
        earlier: expect.stringContaining('before: 3'),
      },
    })
    const earlier = await registry.execute('read_session', { workspace: beta, sessionId: id, maxMessages: 2, before: 3 })
    expect(earlier).toMatchObject({ ok: true, output: { messages: [{ index: 1 }, { index: 2 }] } })
    await expect(registry.execute('read_session', { workspace: beta, sessionId: 'not-an-id' })).resolves.toMatchObject({ ok: false })
  } finally { await dispose() }
})

it('removes both tools on disposal', async () => {
  const { registry, dispose } = await mount([alpha])
  expect(registry.list().map(tool => tool.schema.name)).toEqual(expect.arrayContaining(['search_sessions', 'read_session']))
  await dispose()
  expect(registry.list().some(tool => tool.schema.name === 'search_sessions' || tool.schema.name === 'read_session')).toBe(false)
})

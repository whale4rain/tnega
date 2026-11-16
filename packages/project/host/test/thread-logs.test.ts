import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { ApprovalBroker } from '@tnega/approval-host'
import { Context } from '@tnega/core'
import { projectSessionRoot, workspaceProjectStateRoot } from '@tnega/home'
import type { SessionStore } from '@tnega/session-store'
import { sessionStorePg } from '@tnega/session-store-pg'
import { ProjectHost, projectThreadWorkspace } from '../src/index.js'

let db: PGlite
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  db = new PGlite()
  await db.waitReady
})
afterAll(async () => {
  await db.close()
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const llm: LLMAdapter = { complete: async () => ({ finishReason: 'stop', content: 'Done.' }) }

async function fixture(): Promise<{ host: ProjectHost; store: SessionStore; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-thread-logs-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true }))
  cleanups.push(() => rm(workspaceProjectStateRoot(workspace), { recursive: true, force: true }))
  const ctx = new Context()
  const mounted = await ctx.plugin(sessionStorePg, { sql: db })
  cleanups.push(() => mounted.dispose())
  const store = ctx.get('sessionStore')
  const host = new ProjectHost({ workspace, llm, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker(), threadSessions: store })
  cleanups.push(() => host.dispose())
  return { host, store, workspace }
}

it('keeps Thread Sessions in the session store, not in files, and reads them back after a restart', async () => {
  const { host, store, workspace } = await fixture()
  const record = await host.create({ name: 'Server project' })
  const project = await host.mount(record.id)
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Write the report' })
  const agent = await project.threads.activate(child.id)
  await agent.followup({ text: 'Start' })
  await agent.whenIdle()

  const key = projectThreadWorkspace(workspace, record.id)
  expect((await store.list(key)).map(session => session.id)).toContain(child.id)
  // Nothing under the tnega home's session folder for this project.
  const files = await readdir(join(projectSessionRoot(workspace, record.id), 'agents')).catch(() => [])
  expect(files).toEqual([])

  // A new host over the same database (a server restart) reads the history without running the thread.
  await host.dispose()
  const again = new ProjectHost({ workspace, llm, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker(), threadSessions: store })
  cleanups.push(() => again.dispose())
  const detail = await again.thread(record.id, child.id)
  expect(detail.events.some(event => event.type === 'assistant/message')).toBe(true)
  // A thread that resumes keeps its identity instead of starting a second history.
  const resumed = await (await again.mount(record.id)).threads.activate(child.id)
  expect((await resumed.session.read()).filter(event => event.type === 'meta' && event.payload.kind === 'agent')).toHaveLength(1)
})

it('deletes a project\'s Thread Sessions with the project', async () => {
  const { host, store, workspace } = await fixture()
  const record = await host.create({ name: 'Short-lived' })
  const project = await host.mount(record.id)
  const agent = await project.threads.activate(record.coordinatorId)
  await agent.followup({ text: 'Hello' })
  await agent.whenIdle()
  const key = projectThreadWorkspace(workspace, record.id)
  expect(await store.list(key)).not.toHaveLength(0)
  await host.delete(record.id)
  expect(await store.list(key)).toHaveLength(0)
  expect(existsSync(projectThreadWorkspace(workspace, record.id))).toBe(false)
})

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { ApprovalBroker } from '@tnega/approval-host'
import type { SystemConfig } from '@tnega/config'
import { Context } from '@tnega/core'
import { sessionStoreJsonl } from '@tnega/session-store-jsonl'
import { createResidentRuntime } from '../src/runs.js'
import { sessionModelRoute } from '../src/support.js'

// The coding package's line-based MCP server with one `echo` tool.
const fixture = fileURLToPath(new URL('../../coding-agent/test/fixtures/mcp-server.mjs', import.meta.url))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

it('starts a resident coding session\'s MCP servers before its Agent exists', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-resident-coding-'))
  // Windows can keep a just-killed child's cwd busy for a moment.
  cleanups.push(async () => {
    for (let attempt = 0; ; attempt++) {
      try { await rm(workspace, { recursive: true, force: true }); return } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  })
  await mkdir(join(workspace, '.tnega'), { recursive: true })
  await writeFile(join(workspace, '.tnega', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }))
  const sessionId = randomUUID()
  const stores = new Context()
  await stores.plugin(sessionStoreJsonl)
  const sessions = stores.get('sessionStore')
  const runtime = await createResidentRuntime(workspace, {
    config: {} as SystemConfig,
    prompt: '',
    permission: 'workspace-write',
    sessionId,
    approvals: new ApprovalBroker(),
    agentType: 'coding',
    goalMode: false,
    effective: { apiKeySet: true, modelId: 'model', baseUrl: 'https://llm.invalid', model: 'model', vision: false },
    apiKey: 'key',
    route: sessionModelRoute(sessions, undefined, workspace, sessionId),
    sessions,
  })
  cleanups.push(() => runtime.dispose())
  // The resident root keeps its Agents in a registry and has no Session of its own; the coding plugin must not wait for one.
  expect(runtime.root.get('coding', false)).toBeDefined()
  expect(runtime.root.get('tools').list().map(tool => tool.schema.name)).toContain('mcp__fixture__echo')
})

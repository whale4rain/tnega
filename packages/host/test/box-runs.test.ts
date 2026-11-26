import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { agents, type AgentRegistry, type LLMAdapter } from '@tnega/agent'
import { ApprovalBroker } from '@tnega/approval-host'
import type { SystemConfig } from '@tnega/config'
import { Context } from '@tnega/core'
import { startDaemon } from '@tnega/daemon'
import { acceptDaemon, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { runtimeCapabilities } from '@tnega/runtime'
import { sessionStoreJsonl } from '@tnega/session-store-jsonl'
import { LocalSubagentService } from '@tnega/subagent-local'
import { createResidentRuntime } from '../src/runs.js'
import { sessionModelRoute } from '../src/support.js'

// The coding package's line-based MCP server with one `echo` tool.
const fixture = fileURLToPath(new URL('../../coding-agent/test/fixtures/mcp-server.mjs', import.meta.url))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  // Windows can keep the cwd of a just-exited shell busy for a moment.
  cleanups.push(async () => {
    for (let attempt = 0; ; attempt++) {
      try { await rm(dir, { recursive: true, force: true }); return } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  })
  return dir
}

/** A box stand-in: a daemon in this process on a memory transport, with the calls it got. */
async function loopbackBox(workspace: string): Promise<{ link: DaemonLink; calls: string[] }> {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  // A box's daemon serves pipes (its start script passes --pipes).
  const daemon = startDaemon({ connect: () => daemonSide, workspaces: [{ path: workspace }], reconnect: false, heartbeat: false, terminals: false, pipes: true })
  const link = await accepted
  await daemon.ready
  cleanups.push(async () => { await daemon.close(); link.close() })
  const calls: string[] = []
  const call = link.call.bind(link)
  const counted: DaemonLink['call'] = (method, params, options) => {
    calls.push(method)
    return call(method, params, options)
  }
  link.call = counted
  return { link, calls }
}

it('gives a coding run in a box its subagent tools and the box\'s MCP servers, and no host skill tools', async () => {
  const box = await tempDir('tnega-box-')
  const host = await tempDir('tnega-host-')
  await mkdir(join(box, '.tnega'), { recursive: true })
  await writeFile(join(box, '.tnega', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }))
  const { link, calls } = await loopbackBox(box)
  const stores = new Context()
  await stores.plugin(sessionStoreJsonl)
  const sessions = stores.get('sessionStore')
  const runtime = await createResidentRuntime(host, {
    config: {} as SystemConfig,
    prompt: '',
    permission: 'workspace-write',
    sessionId: 'session',
    approvals: new ApprovalBroker(),
    agentType: 'coding',
    goalMode: false,
    effective: { apiKeySet: true, modelId: 'model', baseUrl: 'https://llm.invalid', model: 'model', vision: false },
    apiKey: 'key',
    route: sessionModelRoute(sessions, undefined, host, 'session'),
    sessions,
    box: { machine: { link, hostWorkspace: host, isolated: true }, cwd: box, identity: 'box:1', release: () => undefined },
  })
  cleanups.push(() => runtime.dispose())
  const names = runtime.root.get('tools').list().map(tool => tool.schema.name)
  expect(names).toContain('spawn_subagent')
  expect(names).toContain('read_subagent_result')
  // The MCP server came from the box's mcp.json and runs on its daemon.
  expect(names).toContain('mcp__fixture__echo')
  expect(calls).toContain('stream/open')
  expect(names).not.toContain('skill')
})

it('runs a subagent\'s commands on the box its parent works in', async () => {
  const box = await tempDir('tnega-box-')
  const host = await tempDir('tnega-host-')
  const { link, calls } = await loopbackBox(box)
  const root = new Context()
  await root.plugin(runtimeCapabilities, {
    workspace: box,
    machine: { link, hostWorkspace: host, isolated: true },
    permission: 'bypass',
    builtin: { allowShell: true },
    search: false, skills: false, office: false, spill: false,
  })
  await root.plugin(agents)
  cleanups.push(() => root.fiber.dispose().then(() => undefined))
  let step = 0
  const llm: LLMAdapter = { async complete() {
    step++
    if (step === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'node -e "console.log(process.cwd())"' } }] }
    return { content: 'done', finishReason: 'stop' }
  } }
  const registry: AgentRegistry = root.get('agents')
  const parent = await registry.create({ id: 'parent', file: join(host, 'parent.jsonl'), llm, manualStreaming: true })
  cleanups.push(() => parent.dispose())
  const service = new LocalSubagentService(root, { cwd: host, llm, allowShell: true, permission: 'bypass' })
  cleanups.push(() => service.dispose())
  await service.start({ parentId: 'parent', task: 'where are you' })
  await expect.poll(async () => (await service.list('parent'))[0]?.status, { timeout: 10_000 }).toBe('idle')
  // The child's shell went to the box's daemon, not to this host.
  expect(calls).toContain('process/shell')
  // Its Session stays with the host's state.
  expect((await service.list('parent'))[0]?.lastOutput).toBe('done')
})

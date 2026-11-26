import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { connectMcpServers } from '@tnega/coding-agent'
import { startDaemon } from '@tnega/daemon'
import { acceptDaemon, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { boxMcp } from '../src/machines.js'

// The coding package's own fixture: a line-based MCP server with one `echo` tool.
const fixture = fileURLToPath(new URL('../../coding-agent/test/fixtures/mcp-server.mjs', import.meta.url))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-box-mcp-'))
  // Windows can keep a just-killed child's cwd busy for a moment.
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

async function box(workspace: string, pipes: boolean): Promise<DaemonLink> {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({ connect: () => daemonSide, workspaces: [{ path: workspace }], reconnect: false, heartbeat: false, terminals: false, pipes })
  const link = await accepted
  await daemon.ready
  cleanups.push(async () => { await daemon.close(); link.close() })
  return link
}

it('reads the box\'s own mcp.json and runs its servers in the box', async () => {
  const inBox = await tempDir()
  const onHost = await tempDir()
  await mkdir(join(inBox, '.tnega'), { recursive: true })
  await writeFile(join(inBox, '.tnega', 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [fixture] } },
  }))
  const options = boxMcp({ link: await box(inBox, true), isolated: true }, inBox)
  if (!options) throw new Error('expected the box to run MCP servers')
  // The host folder has no mcp.json: what runs comes from the box.
  const runtime = await connectMcpServers(onHost, undefined, options)
  cleanups.push(() => runtime.dispose())
  expect(runtime.surveys).toEqual([{ name: 'fixture', status: 'connected', toolCount: 1 }])
  expect(await runtime.tools[0]!.execute({ value: 'from the box' }, {})).toEqual({ content: 'echo:from the box' })
  await runtime.dispose()
  await expect(runtime.tools[0]!.execute({ value: 'again' }, {})).rejects.toThrow(/mcp server closed/)
})

it('starts no servers when the box has no mcp.json', async () => {
  const inBox = await tempDir()
  const options = boxMcp({ link: await box(inBox, true), isolated: true }, inBox)
  if (!options) throw new Error('expected the box to run MCP servers')
  expect(await options.readConfig()).toEqual({})
})

it('goes without MCP servers on a box image that cannot run them', async () => {
  const inBox = await tempDir()
  expect(boxMcp({ link: await box(inBox, false), isolated: true }, inBox)).toBeUndefined()
})

it('gives box servers the egress proxy\'s placeholders, with mcp.json winning', async () => {
  const inBox = await tempDir()
  const options = boxMcp({ link: await box(inBox, true), isolated: true, secrets: { withholdOthers: true, proxied: async () => ['GITHUB_TOKEN'] } }, inBox)
  if (!options) throw new Error('expected the box to run MCP servers')
  const started: Array<Readonly<Record<string, string>> | undefined> = []
  const runtime = await connectMcpServers(inBox, undefined, {
    ...options,
    readConfig: async () => ({ mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { OWN: '1' } } } }),
    launch: (request, handlers) => { started.push(request.env); return options.launch(request, handlers) },
  })
  cleanups.push(() => runtime.dispose())
  expect(started).toEqual([{ GITHUB_TOKEN: 'tnega-egress-adds-GITHUB_TOKEN', OWN: '1' }])
})

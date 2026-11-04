import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { renderToolResult } from '@tnega/session'
import { acceptDaemon, memoryTransportPair } from '@tnega/daemon-protocol'
import { startDaemon } from '@tnega/daemon'
import { RemoteWorkspaceFs } from '@tnega/fs-remote'
import { runtimeCapabilities, type RuntimeSpec } from '../src/compose.js'

const dirs: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)))
  for (const dir of dirs.splice(0)) {
    // Windows can keep the cwd of a just-exited shell busy for a moment.
    for (let attempt = 0; ; attempt++) {
      try { await rm(dir, { recursive: true, force: true }); break } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
})

/** A daemon in this process on a memory transport: every call still goes through JSON. */
async function loopbackDaemon(workspaces: readonly string[]) {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({
    connect: () => daemonSide,
    workspaces: workspaces.map(path => ({ path })),
    reconnect: false,
    heartbeat: false,
  })
  const link = await accepted
  await daemon.ready
  return { link, daemon, close: async () => { await daemon.close(); link.close() } }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-runtime-machine-'))
  dirs.push(dir)
  return dir
}

/** The same tool calls a model would make, in order. */
const script: Array<[string, Record<string, unknown>]> = [
  ['write_file', { path: 'notes/a.txt', content: 'one\ntwo\nthree\n' }],
  ['read_file', { path: 'notes/a.txt' }],
  ['edit_file', { path: 'notes/a.txt', edits: [{ old_string: 'two', new_string: 'TWO' }] }],
  ['read_file', { path: 'notes/a.txt', offset: 2, limit: 1 }],
  ['list_dir', { path: 'notes' }],
  ['read_file', { path: 'missing.txt' }],
  ['shell', { command: 'node -e "console.log(require(\'fs\').readFileSync(\'notes/a.txt\',\'utf8\').length)"' }],
  ['shell', { command: 'node -e "process.exit(3)"' }],
]

async function run(dir: string, extra: Partial<RuntimeSpec>): Promise<string[]> {
  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, {
    workspace: dir,
    permission: 'bypass',
    builtin: { allowShell: true },
    search: false, skills: false, office: false, spill: false,
    ...extra,
  })
  await fiber
  try {
    const out: string[] = []
    for (const [name, args] of script) {
      const result = await ctx.get('tools').execute(name, args)
      out.push(renderToolResult(result).split(dir).join('<ws>'))
    }
    return out
  } finally {
    await fiber.dispose()
  }
}

it('gives the same tool results on this machine and through a daemon', async () => {
  const local = await tempDir()
  const remote = await tempDir()
  const loopback = await loopbackDaemon([remote])
  cleanups.push(() => loopback.close())

  const here = await run(local, {})
  const there = await run(remote, { machine: { link: loopback.link } })
  expect(there).toEqual(here)
  // The daemon really did the work: the file is on its side.
  const fs = new RemoteWorkspaceFs(loopback.link, loopback.daemon.workspaces[0]!)
  expect(Buffer.from(await fs.readFile('notes/a.txt')).toString()).toBe('one\nTWO\nthree\n')
})

it('refuses to open a scope on a workspace the daemon does not serve', async () => {
  const served = await tempDir()
  const other = await tempDir()
  const loopback = await loopbackDaemon([served])
  cleanups.push(() => loopback.close())
  const ctx = new Context()
  await expect(ctx.plugin(runtimeCapabilities, {
    workspace: other,
    machine: { link: loopback.link },
    builtin: { allowShell: true },
    search: false,
  })).rejects.toThrow(/does not serve/)
})

it('never mounts tools that read this machine\'s disk on a daemon scope, even when asked', async () => {
  const dir = await tempDir()
  const loopback = await loopbackDaemon([dir])
  cleanups.push(() => loopback.close())
  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, {
    workspace: dir,
    machine: { link: loopback.link },
    builtin: {},
    search: false, office: true, skills: true,
  })
  await fiber
  try {
    const names = ctx.get('tools').list().map(tool => tool.schema.name)
    expect(names).toContain('read_file')
    expect(names.some(name => name.startsWith('office_'))).toBe(false)
    expect(names).not.toContain('skill')
  } finally {
    await fiber.dispose()
  }
})

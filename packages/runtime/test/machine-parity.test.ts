import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { renderToolResult } from '@tnega/session'
import { acceptDaemon, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { startDaemon, type DaemonBrowser, type DaemonComputer } from '@tnega/daemon'
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
async function loopbackDaemon(workspaces: readonly string[], browser?: DaemonBrowser, computer?: DaemonComputer) {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({
    connect: () => daemonSide,
    workspaces: workspaces.map(path => ({ path })),
    reconnect: false,
    heartbeat: false,
    ...(browser ? { browser } : {}),
    ...(computer ? { computer: { computer } } : {}),
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

/** Just enough of a browser on the daemon for the tools to mount and one action to run. */
function idleBrowser(ran: string[]): DaemonBrowser {
  const page = { url: 'about:blank', title: '' }
  return {
    state: () => page,
    tabs: () => [],
    run: async action => { ran.push(action.op); return page },
    snapshot: async () => ({ ...page, snapshot: '', truncated: false }),
    screenshot: async () => ({ ...page, mediaType: 'image/jpeg', data: '' }),
    evaluate: async () => undefined,
    console: () => [],
    network: () => [],
    onLog: () => () => {},
    live: { subscribe: () => () => {} },
  }
}

it('gives a daemon scope the daemon\'s browser only when the daemon serves one', async () => {
  const dir = await tempDir()
  const ran: string[] = []
  const withBrowser = await loopbackDaemon([dir], idleBrowser(ran))
  const without = await loopbackDaemon([dir])
  cleanups.push(() => withBrowser.close(), () => without.close())
  const spec = { workspace: dir, builtin: {}, search: false, office: false, skills: false, spill: false }

  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, { ...spec, permission: 'bypass', machine: { link: withBrowser.link } })
  await fiber
  try {
    expect(ctx.get('tools').list().map(tool => tool.schema.name)).toContain('browser_navigate')
    const result = await ctx.get('tools').execute('browser_reload', {})
    expect(result.ok).toBe(true)
    expect(ran).toEqual(['reload'])
  } finally {
    await fiber.dispose()
  }

  for (const [link, browser] of [[without.link, undefined], [withBrowser.link, false]] as const) {
    const scope = new Context()
    const mounted = scope.plugin(runtimeCapabilities, { ...spec, machine: { link }, ...(browser === false ? { browser } : {}) })
    await mounted
    try {
      expect(scope.get('tools').list().some(tool => tool.schema.name.startsWith('browser_'))).toBe(false)
    } finally {
      await mounted.dispose()
    }
  }
})

/** One window on the daemon's machine; actions are recorded, not run. */
function oneWindow(ran: string[]): DaemonComputer {
  const window = { id: 1, pid: 10, app: 'notepad.exe', title: 'notes', bounds: { x: 0, y: 0, width: 10, height: 10 }, onScreen: true }
  const shot = { windowId: 1, app: window.app, title: window.title, width: 10, height: 10, mediaType: 'image/png' as const, data: '' }
  return {
    windows: async () => [window],
    apps: async () => [],
    screenshot: async () => shot,
    zoom: async () => shot,
    tree: async () => { throw new Error('not used') },
    act: async action => { ran.push(action.op); return { note: 'done' } },
  }
}

it('gives a daemon scope that daemon\'s computer, and never this machine\'s', async () => {
  const dir = await tempDir()
  const ran: string[] = []
  const offered = await loopbackDaemon([dir], undefined, oneWindow(ran))
  const plain = await loopbackDaemon([dir])
  cleanups.push(() => offered.close(), () => plain.close())
  const spec = { workspace: dir, permission: 'bypass' as const, builtin: {}, search: false, office: false, skills: false, spill: false, computer: { apps: { 'notepad.exe': 'look' as const } } }

  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, { ...spec, machine: { link: offered.link } })
  await fiber
  try {
    const tools = ctx.get('tools')
    expect(tools.list().map(tool => tool.schema.name)).toContain('computer_list_windows')
    expect(renderToolResult(await tools.execute('computer_list_windows', {}))).toContain('notepad.exe')
    // The app tier set for this scope still applies: notepad is look-only here.
    const click = await tools.execute('computer_click', { window_id: 1, x: 1, y: 1 })
    expect(click.ok).toBe(false)
    expect(click.error?.message).toMatch(/look/)
    expect(ran).toEqual([])
  } finally {
    await fiber.dispose()
  }

  // Computer use turned on in settings, but the person at the daemon did not offer it.
  const scope = new Context()
  const mounted = scope.plugin(runtimeCapabilities, { ...spec, machine: { link: plain.link } })
  await mounted
  try {
    expect(scope.get('computer', false)).toBeUndefined()
    expect(scope.get('tools').list().some(tool => tool.schema.name.startsWith('computer_'))).toBe(false)
  } finally {
    await mounted.dispose()
  }
})

it('runs commands in a box without an inner sandbox, whatever the Session permission', async () => {
  const dir = await tempDir()
  const loopback = await loopbackDaemon([dir])
  cleanups.push(() => loopback.close())
  const inner = loopback.link
  const sent: unknown[] = []
  const recording: DaemonLink = {
    get deviceId() { return inner.deviceId },
    get protocolVersion() { return inner.protocolVersion },
    get capabilities() { return inner.capabilities },
    get workspaces() { return inner.workspaces },
    get closed() { return inner.closed },
    call: (method, params, options) => {
      if (method === 'process/shell') sent.push(params)
      return inner.call(method, params, options)
    },
    onNotification: (method, listener) => inner.onNotification(method, listener),
    onClose: listener => inner.onClose(listener),
    close: reason => inner.close(reason),
  }
  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, {
    workspace: dir,
    machine: { link: recording, isolated: true },
    permission: 'read-only',
    sandboxRequired: true,
    builtin: { allowShell: true },
    search: false,
  })
  await fiber
  try {
    const result = await ctx.get('tools').execute('shell', { command: 'node -e "console.log(41 + 1)"' })
    expect(renderToolResult(result)).toContain('42')
    expect(sent).toMatchObject([{ sandbox: { mode: 'bypass' } }])
  } finally {
    await fiber.dispose()
  }
})

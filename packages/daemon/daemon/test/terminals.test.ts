import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { RpcErrorCode, acceptDaemon, memoryTransportPair, resumeStream, forwardService, type DaemonLink, type Transport } from '@tnega/daemon-protocol'
import { TerminalError, type TerminalEvent } from '@tnega/terminal'
import type { PtyLike, TerminalLocalConfig } from '@tnega/terminal-local'
import { terminalRemote } from '@tnega/terminal-remote'
import { terminalRoutes } from '@tnega/terminal-routes'
import { webServer } from '@tnega/web-kit'
import { startDaemon, type Daemon } from '../src/index.js'

class FakePty implements PtyLike {
  written: string[] = []
  size: [number, number] = [0, 0]
  killed = false
  private readonly data = new Set<(data: string) => void>()
  private readonly exit = new Set<(event: { exitCode: number }) => void>()
  onData(listener: (data: string) => void) { this.data.add(listener) }
  onExit(listener: (event: { exitCode: number }) => void) { this.exit.add(listener) }
  write(data: string) { this.written.push(data); this.emit(data) }
  resize(cols: number, rows: number) { this.size = [cols, rows] }
  kill() { this.killed = true }
  emit(data: string) { for (const listener of this.data) listener(data) }
}

const dirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-daemon-terminal-'))
  dirs.push(dir)
  return dir
}

function fakeTerminals(): { config: TerminalLocalConfig; ptys: FakePty[] } {
  const ptys: FakePty[] = []
  return {
    ptys,
    config: {
      shell: { shell: 'fake-sh', args: [] },
      spawn: (_shell, _args, options) => {
        const pty = new FakePty()
        pty.size = [options.cols, options.rows]
        ptys.push(pty)
        return pty
      },
    },
  }
}

/** A daemon that dials a fresh memory connection each time; `links` collects the runtime ends. */
async function reconnectingDaemon(workspace: string, config: TerminalLocalConfig, graceMs = 30_000) {
  const links: Array<Promise<DaemonLink>> = []
  const connect = (): Transport => {
    const [runtimeSide, daemonSide] = memoryTransportPair()
    links.push(acceptDaemon(runtimeSide, { heartbeat: false }))
    return daemonSide
  }
  const daemon: Daemon = startDaemon({
    connect,
    workspaces: [{ path: workspace }],
    heartbeat: false,
    terminals: config,
    streams: { graceMs },
    reconnect: { minDelayMs: 5, maxDelayMs: 5 },
  })
  cleanups.push(() => daemon.close())
  await daemon.ready
  return { daemon, links }
}

const tick = (ms = 10): Promise<void> => new Promise(done => setTimeout(done, ms))

describe('terminals over the daemon', () => {
  it('serves ctx.terminals: create, replayed scrollback, input, resize, close', async () => {
    const dir = await tempDir()
    const { config, ptys } = fakeTerminals()
    const { links } = await reconnectingDaemon(dir, config)
    const ctx = new Context()
    await ctx.plugin(terminalRemote, { link: await links[0]! })
    const terminals = ctx.get('terminals')

    const info = await terminals.create(dir, { cols: 1000, rows: 2 })
    expect(info).toMatchObject({ title: 'fake-sh', cols: 500, rows: 5 })
    ptys[0]!.emit('hello ')
    const seen: TerminalEvent[] = []
    const detach = await terminals.attach(info.id, event => seen.push(event))
    await terminals.write(info.id, 'ls\r')
    await terminals.resize(info.id, 120, 40)
    await tick()
    expect(seen).toEqual([{ type: 'data', data: 'hello ' }, { type: 'data', data: 'ls\r' }])
    expect(ptys[0]!.size).toEqual([120, 40])
    expect(await terminals.list(dir)).toHaveLength(1)
    detach()
    await terminals.close(info.id)
    expect(ptys[0]!.killed).toBe(true)
    // The local error comes back with its status, so the route answers 404 as before.
    const missing = await terminals.write(info.id, 'x').catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(TerminalError)
    expect(missing).toMatchObject({ status: 404 })
  })

  it('opens terminals only inside the workspaces the daemon announced', async () => {
    const dir = await tempDir()
    const outside = await tempDir()
    const { config, ptys } = fakeTerminals()
    const { links } = await reconnectingDaemon(dir, config)
    const remote = forwardService(await links[0]!, 'terminals')
    await expect(remote.call('create', [outside, {}])).rejects.toMatchObject({ rpcCode: RpcErrorCode.WORKSPACE_DENIED })
    await expect(remote.call('spawnAnything', [])).rejects.toMatchObject({ rpcCode: RpcErrorCode.METHOD_NOT_FOUND })
    await expect(forwardService(await links[0]!, 'nothing').call('list', [])).rejects.toMatchObject({ rpcCode: RpcErrorCode.METHOD_NOT_FOUND })
    expect(ptys).toHaveLength(0)
  })

  it('resumes a stream on a new connection with only the events it missed', async () => {
    const dir = await tempDir()
    const { config, ptys } = fakeTerminals()
    const { links } = await reconnectingDaemon(dir, config)
    const first = await links[0]!
    const remote = forwardService(first, 'terminals')
    const info = await remote.call('create', [dir, {}]) as { id: string }
    const seen: unknown[] = []
    const ended: string[] = []
    const stream = await remote.stream('attach', [info.id], { onEvent: event => seen.push(event), onEnd: reason => ended.push(reason) })
    ptys[0]!.emit('a')
    await tick()
    first.close('network blip')
    expect(ended[0]).toMatch(/connection lost/)
    ptys[0]!.emit('b')
    ptys[0]!.emit('c')
    await tick(40)
    const second = await links[1]!
    // Output while the resume is on its way waits for it, so the replay comes first.
    const resuming = resumeStream(second, stream.id, stream.lastSeq, { onEvent: event => seen.push(event) })
    ptys[0]!.emit('d')
    await resuming
    ptys[0]!.emit('e')
    await tick()
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'].map(data => ({ type: 'data', data })))
  })

  it('drops a stream nobody resumes within the grace period', async () => {
    const dir = await tempDir()
    const { config, ptys } = fakeTerminals()
    const { links } = await reconnectingDaemon(dir, config, 20)
    const first = await links[0]!
    const remote = forwardService(first, 'terminals')
    const info = await remote.call('create', [dir, {}]) as { id: string }
    const stream = await remote.stream('attach', [info.id], { onEvent: () => undefined })
    first.close('gone')
    await tick(80)
    const second = await links[1]!
    await expect(resumeStream(second, stream.id, stream.lastSeq, { onEvent: () => undefined }))
      .rejects.toMatchObject({ rpcCode: RpcErrorCode.STREAM_LOST })
    // The terminal itself lives on until it is closed.
    expect(ptys[0]!.killed).toBe(false)
  })

  it('kills its terminals when the daemon stops', async () => {
    const dir = await tempDir()
    const { config, ptys } = fakeTerminals()
    const { daemon, links } = await reconnectingDaemon(dir, config)
    await forwardService(await links[0]!, 'terminals').call('create', [dir, {}])
    await daemon.close()
    expect(ptys[0]!.killed).toBe(true)
  })

  it('answers the Workbench terminal URLs the same way from a remote machine', async () => {
    const dir = await tempDir()
    const { config, ptys } = fakeTerminals()
    const { links } = await reconnectingDaemon(dir, config)
    const ctx = new Context()
    await ctx.plugin(webServer)
    await ctx.plugin(terminalRemote, { link: await links[0]! })
    await ctx.plugin(terminalRoutes)
    const web = ctx.get('webServer')
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = web.match(req.method ?? 'GET', url.pathname)
      if (match.kind === 'route') void match.handler(req, res, url)
      else { res.writeHead(404); res.end() }
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanups.push(() => new Promise<void>(done => server.close(() => done())))
    cleanups.push(() => ctx.fiber.dispose())
    const address = server.address()
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

    const created = await fetch(`${base}/api/terminals?workspace=${encodeURIComponent(dir)}`, { method: 'POST', body: '{"cols":80,"rows":24}' })
    expect(created.status).toBe(200)
    const { id } = await created.json() as { id: string }
    ptys[0]!.emit('ready$ ')
    const controller = new AbortController()
    const stream = await fetch(`${base}/api/terminals/${id}/stream`, { signal: controller.signal })
    expect(stream.headers.get('content-type')).toMatch(/event-stream/)
    const reader = stream.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('ready$ ')
    controller.abort()
    expect((await fetch(`${base}/api/terminals/${id}/input`, { method: 'POST', body: '{"data":"pwd\\r"}' })).status).toBe(200)
    expect(ptys[0]!.written).toEqual(['pwd\r'])
    expect((await fetch(`${base}/api/terminals/nope/input`, { method: 'POST', body: '{"data":"x"}' })).status).toBe(404)
    expect((await fetch(`${base}/api/terminals/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(ptys[0]!.killed).toBe(true)
  })
})

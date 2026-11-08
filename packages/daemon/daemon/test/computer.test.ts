import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  ComputerError,
  ComputerService,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerCallOptions,
  type ComputerPreActionEvent,
  type ComputerScreenshot,
  type ComputerTree,
  type ComputerWindow,
} from '@tnega/computer'
import { computerRemote } from '@tnega/computer-remote'
import { RpcErrorCode, acceptDaemon, forwardService, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { startDaemon, type DaemonComputerGuard } from '../src/index.js'

const NOTEPAD: ComputerWindow = { id: 7, pid: 70, app: 'notepad.exe', title: 'notes.txt', bounds: { x: 0, y: 0, width: 800, height: 600 }, onScreen: true }

/** The apps on the daemon's machine, without a driver: it records what it was asked to do. */
class FakeComputer extends ComputerService {
  readonly performed: ComputerAction[] = []
  readonly signals: AbortSignal[] = []

  async windows(): Promise<ComputerWindow[]> { return [NOTEPAD] }

  async screenshot(windowId: number): Promise<ComputerScreenshot> {
    return { windowId, app: NOTEPAD.app, title: NOTEPAD.title, width: 800, height: 600, mediaType: 'image/png', data: 'AAAA' }
  }

  async zoom(windowId: number): Promise<ComputerScreenshot> { return this.screenshot(windowId) }

  override async tree(windowId: number): Promise<ComputerTree> {
    return { windowId, app: NOTEPAD.app, title: NOTEPAD.title, snapshotId: 's1', markdown: '- [0] Edit', total: 1, returned: 1, truncated: false }
  }

  protected async runAction(action: ComputerAction, options: ComputerCallOptions): Promise<ComputerActionResult> {
    this.performed.push(action)
    if (options.signal) this.signals.push(options.signal)
    if (action.op === 'click' && action.element === 's0:1') throw new ComputerError('COMPUTER_STALE_ELEMENT', 'read the tree again')
    if (action.op === 'type' && action.text === 'slow') {
      await new Promise<void>((_done, fail) => {
        options.signal?.addEventListener('abort', () => fail(new ComputerError('COMPUTER_ABORTED', 'cancelled')))
      })
    }
    return { note: 'clicked', windowId: NOTEPAD.id, effect: 'confirmed', route: 'accessibility' }
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function connect(computer?: { computer: FakeComputer; guard?: DaemonComputerGuard }): Promise<DaemonLink> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-daemon-computer-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({
    connect: () => daemonSide,
    workspaces: [{ path: dir }],
    reconnect: false,
    heartbeat: false,
    terminals: false,
    ...(computer ? { computer } : {}),
  })
  const link = await accepted
  await daemon.ready
  cleanups.push(async () => { await daemon.close(); link.close() })
  return link
}

/** A runtime scope using the daemon's computer, and the fake behind it. */
async function mount(guard?: DaemonComputerGuard) {
  const computer = new FakeComputer(new Context())
  const link = await connect({ computer, ...(guard ? { guard } : {}) })
  const ctx = new Context()
  const mounted = await ctx.plugin(computerRemote, { link })
  cleanups.push(() => mounted.dispose())
  return { ctx, computer, link }
}

const tick = (ms = 10): Promise<void> => new Promise(done => setTimeout(done, ms))

describe('computer use on a daemon', () => {
  it('looks and acts on the daemon\'s apps', async () => {
    const { ctx, computer } = await mount()
    const remote = ctx.get('computer')
    expect(await remote.windows()).toEqual([NOTEPAD])
    expect(await remote.screenshot(7)).toMatchObject({ windowId: 7, mediaType: 'image/png', data: 'AAAA' })
    expect(await remote.zoom(7, { x1: 0, y1: 0, x2: 10, y2: 10 })).toMatchObject({ windowId: 7 })
    expect(await remote.tree(7, { query: 'Edit' })).toMatchObject({ snapshotId: 's1', markdown: '- [0] Edit' })
    expect(await remote.act({ op: 'click', windowId: 7, element: 's1:0' })).toEqual({ note: 'clicked', windowId: 7, effect: 'confirmed', route: 'accessibility' })
    expect(computer.performed).toEqual([{ op: 'click', windowId: 7, element: 's1:0' }])
  })

  it('runs policy here: an action refused by computer/pre-action never reaches the daemon', async () => {
    const { ctx, computer } = await mount()
    const seen: string[] = []
    ctx.on('computer/pre-action', (event: ComputerPreActionEvent, next: () => unknown) => {
      seen.push(event.window?.app ?? '')
      event.deny = 'not in notepad'
      return next()
    })
    await expect(ctx.get('computer').act({ op: 'type', windowId: 7, text: 'hi' })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    // Policy judged the daemon's window, by its app name.
    expect(seen).toEqual(['notepad.exe'])
    expect(computer.performed).toEqual([])
  })

  it('lets the person at the daemon pause everything, and shows each action', async () => {
    let paused = false
    const shown: ComputerAction[] = []
    const { ctx, computer } = await mount({
      paused: () => paused ? 'paused at the computer' : undefined,
      onAction: action => { shown.push(action) },
    })
    const remote = ctx.get('computer')
    await remote.act({ op: 'key', windowId: 7, keys: ['ctrl', 's'] })
    expect(shown).toEqual([{ op: 'key', windowId: 7, keys: ['ctrl', 's'] }])

    paused = true
    await expect(remote.screenshot(7)).rejects.toMatchObject({ code: 'COMPUTER_DENIED', message: 'paused at the computer' })
    await expect(remote.windows()).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    expect(computer.performed).toHaveLength(1)
    paused = false
    expect(await remote.windows()).toEqual([NOTEPAD])
  })

  it('gives back the daemon\'s computer errors with their codes, and cancels on the daemon', async () => {
    const { ctx, computer } = await mount()
    const remote = ctx.get('computer')
    await expect(remote.act({ op: 'click', windowId: 7, element: 's0:1' }))
      .rejects.toSatisfy((error: unknown) => error instanceof ComputerError && error.code === 'COMPUTER_STALE_ELEMENT')

    const controller = new AbortController()
    const typing = remote.act({ op: 'type', windowId: 7, text: 'slow' }, { signal: controller.signal })
    await tick()
    controller.abort()
    await expect(typing).rejects.toBeInstanceOf(ComputerError)
    await tick()
    expect(computer.signals.at(-1)?.aborted).toBe(true)
  })

  it('refuses an action of the wrong shape on the daemon', async () => {
    const { link, computer } = await mount()
    const raw = forwardService(link, 'computer')
    await expect(raw.call('act', [{ op: 'format_disk', windowId: 7 }])).rejects.toMatchObject({ rpcCode: RpcErrorCode.INVALID_PARAMS })
    await expect(raw.call('act', [{ op: 'click', windowId: 7 }])).rejects.toMatchObject({ rpcCode: RpcErrorCode.INVALID_PARAMS })
    await expect(raw.call('act', [{ op: 'click', windowId: 7, element: 's1:0', x: 1, y: 2 }])).rejects.toMatchObject({ rpcCode: RpcErrorCode.INVALID_PARAMS })
    await expect(raw.call('screenshot', ['7'])).rejects.toMatchObject({ rpcCode: RpcErrorCode.INVALID_PARAMS })
    expect(computer.performed).toEqual([])
  })

  it('is not offered unless the daemon was started with it', async () => {
    const link = await connect()
    expect(link.capabilities.services ?? []).not.toContain('computer')
    await expect(new Context().plugin(computerRemote, { link })).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' })
  })
})

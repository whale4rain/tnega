import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  BrowserError,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserCallOptions,
  type BrowserConsoleEntry,
  type BrowserLogEvent,
  type BrowserNetworkEntry,
  type BrowserPreActionEvent,
  type BrowserTab,
} from '@tnega/browser'
import { browserRemote } from '@tnega/browser-remote'
import { RpcErrorCode, acceptDaemon, forwardService, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { startDaemon, type DaemonBrowser } from '../src/index.js'

/** A browser on the daemon's machine, without Playwright: it records what it was asked. */
class FakeBrowser implements DaemonBrowser {
  readonly actions: BrowserAction[] = []
  readonly signals: AbortSignal[] = []
  url = 'about:blank'
  title = ''
  readonly liveListeners = new Set<(event: { type: string }) => void>()
  readonly logListeners = new Set<(event: BrowserLogEvent) => void>()
  private readonly consoleLog: BrowserConsoleEntry[] = []
  /** Holds `wait` actions until released, to test cancelling. */
  release: () => void = () => {}

  readonly live = {
    subscribe: (listener: (event: { type: string }) => void) => {
      this.liveListeners.add(listener)
      return () => { this.liveListeners.delete(listener) }
    },
  }

  state() { return { url: this.url, title: this.title } }
  tabs(): BrowserTab[] { return [{ id: 't1', url: this.url, title: this.title, active: true }] }

  async run(action: BrowserAction, options: BrowserCallOptions = {}): Promise<BrowserActionResult> {
    this.actions.push(action)
    if (options.signal) this.signals.push(options.signal)
    if (action.op === 'click' && action.ref === 'gone') throw new BrowserError('BROWSER_STALE_REF', 'ref gone is not on the page any more')
    if (action.op === 'wait') {
      await new Promise<void>((done, fail) => {
        this.release = done
        options.signal?.addEventListener('abort', () => fail(new BrowserError('BROWSER_ABORTED', 'cancelled')))
      })
    }
    if (action.op === 'navigate') {
      this.url = action.url
      this.title = 'Example'
      const state = { type: 'state', url: this.url, title: this.title }
      const tabs = { type: 'tabs', tabs: this.tabs() }
      for (const listener of this.liveListeners) {
        listener(state)
        listener(tabs)
      }
      this.log({ kind: 'console', entry: { type: 'error', text: 'boom', time: 2 } })
      this.log({ kind: 'console', entry: { type: 'log', text: 'hello', time: 3 } })
      this.log({ kind: 'network', entry: { method: 'GET', url: action.url, resourceType: 'document', status: 200, time: 4 } })
    }
    return { url: this.url, title: this.title, note: 'HTTP 200' }
  }

  private log(event: BrowserLogEvent): void {
    if (event.kind === 'console') this.consoleLog.push(event.entry)
    for (const listener of this.logListeners) listener(event)
  }

  async snapshot() { return { url: this.url, title: this.title, snapshot: '- button "Go" [ref=e1]', truncated: false } }
  async screenshot() { return { url: this.url, title: this.title, mediaType: 'image/jpeg' as const, data: 'AAAA' } }
  async evaluate(expression: string) { return { expression } }
  console(): BrowserConsoleEntry[] { return [...this.consoleLog] }
  network(): BrowserNetworkEntry[] { return [] }
  onLog(listener: (event: BrowserLogEvent) => void) {
    this.logListeners.add(listener)
    return () => { this.logListeners.delete(listener) }
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function connect(browser?: DaemonBrowser): Promise<DaemonLink> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-daemon-browser-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({
    connect: () => daemonSide,
    workspaces: [{ path: dir }],
    reconnect: false,
    heartbeat: false,
    terminals: false,
    ...(browser ? { browser } : {}),
  })
  const link = await accepted
  await daemon.ready
  cleanups.push(async () => { await daemon.close(); link.close() })
  return link
}

const tick = (ms = 10): Promise<void> => new Promise(done => setTimeout(done, ms))

async function mount(browser: FakeBrowser) {
  const link = await connect(browser)
  const ctx = new Context()
  const mounted = await ctx.plugin(browserRemote, { link })
  cleanups.push(() => mounted.dispose())
  return { ctx, link }
}

describe('a browser on a daemon', () => {
  it('drives the daemon\'s browser and keeps the page, tabs and logs current here', async () => {
    const browser = new FakeBrowser()
    const { ctx } = await mount(browser)
    const remote = ctx.get('browser')
    expect(remote.page()).toEqual({ url: 'about:blank', title: '' })

    expect(await remote.act({ op: 'navigate', url: 'https://example.com/' })).toEqual({ url: 'https://example.com/', title: 'Example', note: 'HTTP 200' })
    expect(browser.actions).toEqual([{ op: 'navigate', url: 'https://example.com/' }])
    await tick()
    expect(remote.page()).toEqual({ url: 'https://example.com/', title: 'Example' })
    expect(remote.tabs()).toEqual([{ id: 't1', url: 'https://example.com/', title: 'Example', active: true }])
    expect(remote.console().map(entry => entry.text)).toEqual(['boom', 'hello'])
    expect(remote.console({ onlyProblems: true }).map(entry => entry.text)).toEqual(['boom'])
    expect(remote.network()).toEqual([{ method: 'GET', url: 'https://example.com/', resourceType: 'document', status: 200, time: 4 }])

    expect(await remote.snapshot()).toMatchObject({ snapshot: '- button "Go" [ref=e1]', truncated: false })
    expect(await remote.screenshot({ fullPage: true })).toMatchObject({ mediaType: 'image/jpeg', data: 'AAAA' })
    expect(await remote.evaluate('document.title')).toEqual({ expression: 'document.title' })
  })

  it('runs policy here: an action refused by browser/pre-action never reaches the daemon', async () => {
    const browser = new FakeBrowser()
    const { ctx } = await mount(browser)
    ctx.on('browser/pre-action', (event: BrowserPreActionEvent, next: () => unknown) => {
      if (event.action.op === 'navigate') event.deny = 'no browsing in this test'
      return next()
    })
    await expect(ctx.get('browser').act({ op: 'navigate', url: 'https://example.com/' })).rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    expect(browser.actions).toEqual([])
  })

  it('gives back the daemon\'s browser errors with their codes, and cancels on the daemon', async () => {
    const browser = new FakeBrowser()
    const { ctx } = await mount(browser)
    const remote = ctx.get('browser')
    await expect(remote.act({ op: 'click', ref: 'gone' })).rejects.toSatisfy((error: unknown) => error instanceof BrowserError && error.code === 'BROWSER_STALE_REF')

    const controller = new AbortController()
    const waiting = remote.act({ op: 'wait', ms: 60_000 }, { signal: controller.signal })
    await tick()
    controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(BrowserError)
    await tick()
    expect(browser.signals.at(-1)?.aborted).toBe(true)
  })

  it('refuses an action of the wrong shape on the daemon', async () => {
    const browser = new FakeBrowser()
    const link = await connect(browser)
    const raw = forwardService(link, 'browser')
    await expect(raw.call('run', [{ op: 'click' }])).rejects.toMatchObject({ rpcCode: RpcErrorCode.INVALID_PARAMS })
    await expect(raw.call('run', [{ op: 'format_disk' }])).rejects.toMatchObject({ rpcCode: RpcErrorCode.INVALID_PARAMS })
    expect(browser.actions).toEqual([])
  })

  it('stops following the daemon\'s browser when the scope is disposed', async () => {
    const browser = new FakeBrowser()
    const link = await connect(browser)
    const ctx = new Context()
    const mounted = await ctx.plugin(browserRemote, { link })
    await tick()
    expect(browser.liveListeners.size).toBe(1)
    expect(browser.logListeners.size).toBe(1)
    await mounted.dispose()
    await tick()
    expect(browser.liveListeners.size).toBe(0)
    expect(browser.logListeners.size).toBe(0)
    expect(ctx.get('browser', false)).toBeUndefined()
  })

  it('fails to mount when the daemon serves no browser', async () => {
    const link = await connect()
    expect(link.capabilities.services ?? []).not.toContain('browser')
    await expect(new Context().plugin(browserRemote, { link })).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
  })
})

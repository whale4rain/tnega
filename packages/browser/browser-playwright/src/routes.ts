import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@tnega/core'
import { readJsonBody, sendError, sendJson, writeSse } from '@tnega/web-kit'
import type { PlaywrightBrowserHost } from './host.js'
import { parseLiveInput } from './live.js'

export interface BrowserRoutesConfig {
  /** The host owns the browser lifecycle; the route layer only reads it. */
  browser(): PlaywrightBrowserHost | undefined
}

/** The agent-browser endpoints the Workbench drives. */
export const browserRoutes = {
  name: 'browser-routes',
  inject: ['webServer'],
  apply(ctx: Context, config: BrowserRoutesConfig): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'prefix',
      method: '*',
      path: '/api/browser',
      handler: (req, res, url) => handleBrowser(req, res, url, config.browser()),
    }))
  },
}

async function handleBrowser(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  browser: PlaywrightBrowserHost | undefined,
): Promise<void> {
  if (url.pathname === '/api/browser' && req.method === 'GET') {
    sendJson(res, 200, { available: Boolean(browser), state: browser?.state(), tabs: browser?.tabs() ?? [] })
    return
  }
  if (!browser) {
    sendError(res, 404, 'the agent browser is disabled')
    return
  }
  if (url.pathname === '/api/browser/live' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    writeSse(res, { type: 'state', ...browser.state() })
    writeSse(res, { type: 'tabs', tabs: browser.tabs() })
    let pending = false
    const unsubscribe = browser.live.subscribe(event => {
      if (res.destroyed || res.writableEnded) return
      // Drop frames while the socket is still flushing the previous one.
      if (event.type === 'frame' && pending) return
      pending = !writeSse(res, event)
    }, { frames: url.searchParams.get('frames') !== '0' })
    res.on('drain', () => { pending = false })
    req.on('close', unsubscribe)
    return
  }
  if (url.pathname === '/api/browser/input' && req.method === 'POST') {
    const input = parseLiveInput(await readJsonBody(req))
    if (!input) {
      sendError(res, 400, 'invalid browser input')
      return
    }
    await browser.live.input(input)
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/api/browser/navigate' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body.url !== 'string' || !body.url.trim()) {
      sendError(res, 400, 'url is required')
      return
    }
    await browser.userNavigate(body.url)
    sendJson(res, 200, browser.state())
    return
  }
  if (url.pathname === '/api/browser/viewport' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const width = Number(body.width)
    const height = Number(body.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 8000 || height > 8000) {
      sendError(res, 400, 'width and height must be positive numbers')
      return
    }
    await browser.setViewport(width, height)
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/api/browser/tabs' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const id = typeof body.id === 'string' ? body.id : undefined
    if (body.action === 'new') await browser.newTab(typeof body.url === 'string' && body.url.trim() ? body.url : undefined)
    else if (body.action === 'select' && id) await browser.selectTab(id)
    else if (body.action === 'close') await browser.closeTab(id)
    else {
      sendError(res, 400, 'action must be new, select (with id) or close')
      return
    }
    sendJson(res, 200, { tabs: browser.tabs() })
    return
  }
  if (url.pathname === '/api/browser/pick' && req.method === 'POST') {
    const result = await browser.pick()
    sendJson(res, 200, result ?? { cancelled: true })
    return
  }
  if (url.pathname === '/api/browser/pick/cancel' && req.method === 'POST') {
    await browser.cancelPick()
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/api/browser/command' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (body.command !== 'back' && body.command !== 'forward' && body.command !== 'reload') {
      sendError(res, 400, 'command must be back, forward or reload')
      return
    }
    await browser.userCommand(body.command)
    sendJson(res, 200, browser.state())
    return
  }
  sendError(res, 404, 'not found')
}

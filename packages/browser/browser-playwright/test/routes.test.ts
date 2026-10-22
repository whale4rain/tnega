import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { Context } from '@tnega/core'
import { webServer } from '@tnega/web-kit'
import { browserRoutes, PlaywrightBrowserHost } from '../src/index.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

/** A host whose page never starts: the route only reads it and relays what it announces. */
async function serve(): Promise<{ host: PlaywrightBrowserHost; base: string }> {
  const never = () => new Promise<Page>(() => {})
  const host = new PlaywrightBrowserHost({ acquire: never, open: never, closePage: async () => {}, release: async () => {} })
  const ctx = new Context()
  const fiber = ctx.plugin(webServer)
  await fiber
  const routes = ctx.plugin(browserRoutes, { browser: () => host })
  await routes
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = ctx.webServer.match(req.method ?? 'GET', url.pathname)
    if (match.kind === 'route') void match.handler(req, res, url)
    else res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await routes.dispose()
    await fiber.dispose()
  })
  return { host, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

it('delivers tab and page changes on the live stream as separate events', async () => {
  const { host, base } = await serve()
  const controller = new AbortController()
  cleanups.push(async () => controller.abort())
  const response = await fetch(`${base}/api/browser/live?frames=0`, { signal: controller.signal })
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  const events = () => text.split('\n\n').slice(0, -1).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as { type: string })
  const readUntil = async (count: number) => {
    while (events().length < count) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      text += value
    }
  }

  // The snapshot on connect: page state, then (still empty) tabs.
  await readUntil(2)
  expect(events().map(event => event.type)).toEqual(['state', 'tabs'])

  // Later changes must arrive on their own, not wait for the next connection.
  host.live.emitTabs([{ id: 't1', url: 'about:blank', title: '', active: true }])
  host.live.emitState({ url: 'https://example.com/', title: 'Example' })
  await readUntil(4)
  expect(events().slice(2)).toEqual([
    { type: 'tabs', tabs: [{ id: 't1', url: 'about:blank', title: '', active: true }] },
    { type: 'state', url: 'https://example.com/', title: 'Example' },
  ])
})

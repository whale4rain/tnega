import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { AccountService } from '@tnega/accounts'
import { accountsPg } from '@tnega/accounts-pg'
import { accountsRoutes } from '@tnega/accounts-routes'
import { connectWebSocket, startDaemon, type Daemon } from '@tnega/daemon'
import { daemons, type DaemonRegistry } from '@tnega/daemons'
import { sendJson, webServer } from '@tnega/web-kit'
import { daemonGateway } from '../src/index.js'

let db: PGlite
let ctx: Context
let server: Server
let port = 0
let dir: string
let accounts: AccountService
let registry: DaemonRegistry
const running: Daemon[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tnega-gateway-'))
  db = new PGlite()
  ctx = new Context()
  await ctx.plugin(webServer)
  await ctx.plugin(accountsPg, { sql: db })
  await ctx.plugin(accountsRoutes, { membersRoot: join(dir, 'members') })
  await ctx.plugin(daemons)
  await ctx.plugin(daemonGateway, { recheckMs: 50 })
  accounts = ctx.get('accounts')
  registry = ctx.get('daemons')
  const web = ctx.get('webServer')
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (await web.guard(req, res, url)) return
      const match = web.match(req.method ?? 'GET', url.pathname)
      if (match.kind === 'route') await match.handler(req, res, url)
      else sendJson(res, 404, { error: 'not found' })
    })().catch(error => sendJson(res, 500, { error: String(error) }))
  })
  // The same dispatch as the host's server.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const handler = web.upgrade(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (handler) handler(req, socket, head)
    else socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterAll(async () => {
  await Promise.all(running.splice(0).map(daemon => daemon.close().catch(() => undefined)))
  await ctx.fiber.dispose()
  await new Promise<void>(done => server.close(() => done()))
  await db.close()
  await rm(dir, { recursive: true, force: true })
})

function dial(token: string): Daemon {
  const daemon = startDaemon({
    connect: () => connectWebSocket(`ws://127.0.0.1:${port}/daemon`, { token }),
    workspaces: [{ path: dir }],
    reconnect: false,
    terminals: false,
  })
  running.push(daemon)
  return daemon
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('daemon gateway', () => {
  it('lets a daemon in with a token from a pairing code, under the server device id', async () => {
    const owner = await accounts.createAccount({ login: 'owner', role: 'owner', password: 'correct horse battery' })
    const { code } = await accounts.issueCode({ purpose: 'daemon', accountId: owner.id })
    const paired = await fetch(`http://127.0.0.1:${port}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tnega-client': '1' },
      body: JSON.stringify({ code, purpose: 'daemon', device: 'laptop' }),
    })
    expect(paired.status).toBe(200)
    const body: unknown = await paired.json()
    const token = typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string' ? body.token : ''
    const device = (await accounts.authenticate(token))?.device
    expect(device?.kind).toBe('daemon')
    const daemon = dial(token)
    await daemon.ready
    const connected = await registry.wait(device?.id ?? '', 3_000)
    expect(connected.accountId).toBe(owner.id)
    expect(connected.link.workspaces.map(workspace => workspace.path)).toEqual([dir])
    const stat = await connected.link.call('fs/stat', { workspaceId: connected.link.workspaces[0]?.id ?? '', path: dir })
    expect(stat).toMatchObject({ kind: 'dir' })
    // The code was spent.
    await expect(accounts.redeemCode(code, { purpose: 'daemon', deviceName: 'again' })).rejects.toThrow()
  })

  it('refuses no token, a bad token and a browser token', async () => {
    const mia = await accounts.createAccount({ login: 'mia', role: 'member', password: 'correct horse battery' })
    await expect(connectWebSocket(`ws://127.0.0.1:${port}/daemon`, { connectTimeoutMs: 2_000 })).rejects.toThrow()
    await expect(connectWebSocket(`ws://127.0.0.1:${port}/daemon`, { token: 'tnd_nope', connectTimeoutMs: 2_000 })).rejects.toThrow()
    const browser = await accounts.signIn('mia', 'correct horse battery', { name: 'browser' })
    await expect(connectWebSocket(`ws://127.0.0.1:${port}/daemon`, { token: browser.token, connectTimeoutMs: 2_000 })).rejects.toThrow()
    expect(registry.list().some(daemon => daemon.accountId === mia.id)).toBe(false)
  })

  it('drops a connected daemon when its device is revoked or its account disabled', async () => {
    const ben = await accounts.createAccount({ login: 'ben', role: 'member', password: 'correct horse battery' })
    const first = await accounts.createDevice(ben.id, { kind: 'daemon', name: 'box one' })
    const second = await accounts.createDevice(ben.id, { kind: 'daemon', name: 'box two' })
    dial(first.token)
    dial(second.token)
    const one = await registry.wait(first.principal.device.id, 3_000)
    const two = await registry.wait(second.principal.device.id, 3_000)
    await accounts.revokeDevice(ben.id, first.principal.device.id)
    await until(() => one.link.closed)
    expect(two.link.closed).toBe(false)
    await accounts.updateAccount(ben.id, { disabled: true })
    await until(() => two.link.closed)
    expect(registry.get(second.principal.device.id)).toBeUndefined()
  })
})

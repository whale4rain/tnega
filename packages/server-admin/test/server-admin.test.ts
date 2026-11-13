import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { Account, AccountService } from '@tnega/accounts'
import { accountsPg } from '@tnega/accounts-pg'
import { accountsRoutes } from '@tnega/accounts-routes'
import type { DaemonLink } from '@tnega/daemon-protocol'
import { daemons } from '@tnega/daemons'
import { MachineService, type MachineRef, type MachineState } from '@tnega/machine'
import { machinePool } from '@tnega/machine-pool'
import { sendJson, webServer } from '@tnega/web-kit'
import { serverAdmin } from '../src/index.js'

const PASSWORD = 'correct horse battery'

class FakeMachines extends MachineService {
  readonly kind = 'fake'
  readonly calls: string[] = []
  async start(key: string): Promise<MachineRef> { return { ref: `box-${key.slice(0, 8)}` } }
  async pause(ref: string): Promise<void> { this.calls.push(`pause ${ref}`) }
  async stop(ref: string): Promise<void> { this.calls.push(`stop ${ref}`) }
  async status(): Promise<MachineState> { return 'running' }
}

function fakeLink(deviceId: string): DaemonLink {
  let closed = false
  const listeners = new Set<(reason?: string) => void>()
  return {
    deviceId,
    protocolVersion: 2,
    capabilities: { fs: true, process: true, http: true, platform: 'linux' },
    workspaces: [],
    get closed() { return closed },
    call: () => Promise.reject(new Error('not used')),
    onNotification: () => () => undefined,
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close(reason) { if (closed) return; closed = true; for (const listener of listeners) listener(reason) },
  }
}

let db: PGlite
let ctx: Context
let server: Server
let base: string
let dir: string
let accounts: AccountService
let owner: Account
let admin: Account
let mia: Account

async function listen(scope: Context): Promise<void> {
  const web = scope.get('webServer')
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (await web.guard(req, res, url)) return
      const match = web.match(req.method ?? 'GET', url.pathname)
      if (match.kind === 'route') await match.handler(req, res, url)
      else sendJson(res, 404, { error: 'not found' })
    })().catch(error => sendJson(res, 500, { error: String(error) }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

async function signIn(login: string): Promise<string> {
  const { token } = await accounts.signIn(login, PASSWORD, { name: 'test' })
  return token
}

async function call(token: string, method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-tnega-client': '1' } })
  const body: unknown = await response.json()
  return { status: response.status, body: typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : {} }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tnega-admin-'))
  db = new PGlite()
  ctx = new Context()
  await ctx.plugin(webServer)
  await ctx.plugin(accountsPg, { sql: db })
  await ctx.plugin(accountsRoutes, { membersRoot: join(dir, 'members') })
  await ctx.plugin(serverAdmin)
  accounts = ctx.get('accounts')
  owner = await accounts.createAccount({ login: 'owner', role: 'owner', password: PASSWORD })
  admin = await accounts.createAccount({ login: 'ada', role: 'admin', password: PASSWORD })
  mia = await accounts.createAccount({ login: 'mia', role: 'member', password: PASSWORD })
  await listen(ctx)
})

afterEach(async () => {
  await new Promise<void>(done => server.close(() => done()))
  await ctx.fiber.dispose()
  await db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('server admin', () => {
  it('lists people and their devices for owners and admins, and refuses members', async () => {
    const token = await signIn('owner')
    const { status, body } = await call(token, 'GET', '/api/admin/overview')
    expect(status).toBe(200)
    expect(body.people).toEqual(expect.arrayContaining([expect.objectContaining({ login: 'mia', role: 'member' })]))
    expect(body.devices).toEqual([expect.objectContaining({ accountId: owner.id, kind: 'client', connected: false, box: false })])
    expect(body.boxes).toBeUndefined()
    expect((await call(await signIn('ada'), 'GET', '/api/admin/overview')).status).toBe(200)
    expect((await call(await signIn('mia'), 'GET', '/api/admin/overview')).status).toBe(403)
  })

  it('shows boxes and connected daemons, and pauses and stops a box', async () => {
    await ctx.plugin(daemons)
    const machines = new FakeMachines(ctx)
    await ctx.plugin(machinePool, { sql: db, serverUrl: 'ws://10.0.0.5:7777/daemon', plainServer: true, template: 'tnega-box', maxRunning: 2 })
    const daemon = await accounts.createDevice(mia.id, { kind: 'daemon', name: 'box' })
    ctx.get('daemons').add({ deviceId: daemon.principal.device.id, accountId: mia.id, link: fakeLink(daemon.principal.device.id) })
    const id = randomUUID()
    await db.query(`insert into machine (id, account_id, workspace, provider, ref, state, device_id) values ($1, $2, $3, 'fake', 'box-1', 'running', $4)`, [id, mia.id, '/srv/mia', daemon.principal.device.id])
    const token = await signIn('ada')
    const { body } = await call(token, 'GET', '/api/admin/overview')
    expect(body.boxes).toEqual({
      provider: 'fake',
      maxRunning: 2,
      list: [expect.objectContaining({ id, accountId: mia.id, workspace: '/srv/mia', state: 'running', connected: true })],
    })
    expect(body.devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: daemon.principal.device.id, kind: 'daemon', connected: true, box: true })]))
    expect((await call(token, 'POST', `/api/admin/boxes/pause?id=${id}`)).status).toBe(200)
    expect(machines.calls).toEqual(['pause box-1'])
    expect((await call(token, 'POST', `/api/admin/boxes/stop?id=${id}`)).status).toBe(200)
    expect(machines.calls).toEqual(['pause box-1', 'stop box-1'])
    expect((await call(token, 'POST', `/api/admin/boxes/stop?id=${id}`)).status).toBe(404)
    expect((await call(token, 'POST', '/api/admin/boxes/stop?id=../x')).status).toBe(400)
  })

  it('answers 404 for box actions on a server without boxes', async () => {
    expect((await call(await signIn('owner'), 'POST', `/api/admin/boxes/pause?id=${randomUUID()}`)).status).toBe(404)
  })

  it('revokes a member\'s device and disconnects its daemon, but an admin cannot touch an owner\'s', async () => {
    await ctx.plugin(daemons)
    const daemon = await accounts.createDevice(mia.id, { kind: 'daemon', name: 'laptop' })
    const deviceId = daemon.principal.device.id
    const link = fakeLink(deviceId)
    ctx.get('daemons').add({ deviceId, accountId: mia.id, link })
    const token = await signIn('ada')
    expect((await call(token, 'DELETE', `/api/admin/devices?account=${mia.id}&id=${deviceId}`)).status).toBe(200)
    expect(link.closed).toBe(true)
    expect(await accounts.authenticate(daemon.token)).toBeUndefined()
    const phone = (await accounts.signIn('owner', PASSWORD, { name: 'phone' })).principal.device.id
    expect((await call(token, 'DELETE', `/api/admin/devices?account=${owner.id}&id=${phone}`)).status).toBe(403)
    expect((await accounts.listDevices(owner.id)).map(device => device.id)).toContain(phone)
    // Their own devices are theirs to sign out.
    const own = (await accounts.listDevices(admin.id))[0]?.id ?? ''
    expect((await call(token, 'DELETE', `/api/admin/devices?account=${admin.id}&id=${own}`)).status).toBe(200)
  })
})

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { AccountService } from '@tnega/accounts'
import { accountsPg } from '@tnega/accounts-pg'
import { sendJson, webServer } from '@tnega/web-kit'
import { accountsRoutes } from '../src/index.js'

const PASSWORD = 'correct horse battery'
let db: PGlite
let ctx: Context
let server: Server
let base: string
let root: string
let accounts: AccountService

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tnega-accounts-'))
  db = new PGlite()
  ctx = new Context()
  await ctx.plugin(webServer)
  await ctx.plugin(accountsPg, { sql: db })
  await ctx.plugin(accountsRoutes, { membersRoot: join(root, 'members'), rateLimit: { failures: 3, windowMs: 60_000, lockMs: 60_000 }, trustProxy: true })
  accounts = ctx.get('accounts')
  const web = ctx.get('webServer')
  // Stands in for the host's API: echoes what reached it.
  web.register({
    kind: 'prefix',
    method: '*',
    path: '/api/',
    handler: (req, res, url) => sendJson(res, 200, { reached: url.pathname, sandboxRequired: web.attributes(req).sandboxRequired ?? false, login: web.attributes(req).principal?.login }),
  })
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
  await accounts.createAccount({ login: 'owner', role: 'owner', password: PASSWORD })
  await accounts.createAccount({ login: 'mia', role: 'member', password: PASSWORD })
  await accounts.createAccount({ login: 'ben', role: 'member', password: PASSWORD })
})
afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()))
  await ctx.fiber.dispose()
  await db.close()
  await rm(root, { recursive: true, force: true })
})

interface Reply { status: number; body: Record<string, unknown>; cookie: string | null }

async function call(method: string, path: string, options: { token?: string; cookie?: string; body?: unknown; from?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'x-tnega-client': '1' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.cookie) headers.cookie = options.cookie
  if (options.from) headers['x-forwarded-for'] = options.from
  const response = await fetch(`${base}${path}`, { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) })
  const text = await response.text()
  const parsed: unknown = text ? JSON.parse(text) : {}
  const body: Record<string, unknown> = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {}
  return { status: response.status, body, cookie: response.headers.get('set-cookie') }
}

async function tokenFor(login: string): Promise<string> {
  const reply = await call('POST', '/api/auth/session', { body: { login, password: PASSWORD, token: true } })
  expect(reply.status).toBe(200)
  const token = reply.body.token
  if (typeof token !== 'string') throw new Error('no token')
  return token
}

describe('sign-in over HTTP', () => {
  it('asks for sign-in, and lets health through', async () => {
    expect((await call('GET', '/api/sessions?workspace=/tmp')).status).toBe(401)
    expect((await call('GET', '/api/health')).status).toBe(200)
  })

  it('signs a browser in with an HttpOnly cookie and out again', async () => {
    const reply = await call('POST', '/api/auth/session', { body: { login: 'owner', password: PASSWORD } })
    expect(reply.status).toBe(200)
    expect(reply.body.token).toBeUndefined()
    expect(reply.cookie).toMatch(/^tnega_token=tnk_[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/u)
    const cookie = (reply.cookie ?? '').split(';')[0] ?? ''
    const me = await call('GET', '/api/auth/session', { cookie })
    expect(me.body.account).toMatchObject({ login: 'owner', role: 'owner' })
    expect((await call('GET', '/api/config', { cookie })).status).toBe(200)
    const out = await call('DELETE', '/api/auth/session', { cookie })
    expect(out.cookie).toContain('Max-Age=0')
    expect((await call('GET', '/api/auth/session', { cookie })).status).toBe(401)
  })

  it('locks an address out after repeated failures', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await call('POST', '/api/auth/session', { from: '203.0.113.9', body: { login: 'ben', password: 'not the password' } })).status).toBe(401)
    }
    expect((await call('POST', '/api/auth/session', { from: '203.0.113.9', body: { login: 'ben', password: PASSWORD } })).status).toBe(429)
    // Another address is not held up.
    expect((await call('POST', '/api/auth/session', { from: '203.0.113.10', body: { login: 'ben', password: PASSWORD } })).status).toBe(200)
  })

  it('counts the address the proxy saw, not one the client wrote in front of it', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const spoofed = `198.51.100.${attempt}, 203.0.113.20`
      expect((await call('POST', '/api/auth/session', { from: spoofed, body: { login: 'ben', password: 'not the password' } })).status).toBe(401)
    }
    expect((await call('POST', '/api/auth/session', { from: '198.51.100.99, 203.0.113.20', body: { login: 'ben', password: PASSWORD } })).status).toBe(429)
  })
})

describe('what a member may reach', () => {
  it('keeps a member in their own folder and off host settings', async () => {
    const mia = await tokenFor('mia')
    const workspaces = await call('GET', '/api/workspaces', { token: mia })
    const home = join(root, 'members', 'mia')
    expect(workspaces.body).toEqual({ workspaces: [home], defaultWorkspace: home })
    const own = await call('GET', `/api/sessions?workspace=${encodeURIComponent(join(home, 'project'))}`, { token: mia })
    expect(own.body).toEqual({ reached: '/api/sessions', sandboxRequired: true, login: 'mia' })
    expect((await call('GET', `/api/sessions?workspace=${encodeURIComponent(join(root, 'members', 'ben'))}`, { token: mia })).status).toBe(403)
    expect((await call('GET', `/api/sessions?workspace=${encodeURIComponent(join(home, '..', 'ben'))}`, { token: mia })).status).toBe(403)
    expect((await call('GET', '/api/sessions', { token: mia })).status).toBe(403)
    // A link inside the folder that leads out of it.
    await mkdir(join(root, 'members', 'ben'), { recursive: true })
    await symlink(join(root, 'members', 'ben'), join(home, 'escape'))
    expect((await call('GET', `/api/files?workspace=${encodeURIComponent(join(home, 'escape'))}`, { token: mia })).status).toBe(403)
    for (const path of ['/api/terminals', '/api/plugins', '/api/folder-picker', '/api/auth/users']) {
      expect((await call('GET', `${path}?workspace=${encodeURIComponent(home)}`, { token: mia })).status, path).toBe(403)
    }
    expect((await call('PUT', '/api/config', { token: mia, body: {} })).status).toBe(403)
    expect((await call('GET', '/api/config', { token: mia })).status).toBe(200)
  })

  it('lets the owner through everywhere, without the sandbox rule', async () => {
    const owner = await call('GET', '/api/terminals', { token: await accounts.issueCode({ purpose: 'client', accountId: (await accounts.findAccount('owner'))?.id ?? '' }).then(async issued => String((await call('POST', '/api/auth/pair', { body: { code: issued.code } })).body.token)) })
    expect(owner.body).toEqual({ reached: '/api/terminals', sandboxRequired: false, login: 'owner' })
  })

  it('keeps daemon tokens off the HTTP API', async () => {
    const account = await accounts.findAccount('ben')
    const issued = await accounts.issueCode({ purpose: 'daemon', accountId: account?.id ?? '' })
    const paired = await call('POST', '/api/auth/pair', { body: { code: issued.code, purpose: 'daemon', device: 'laptop' } })
    expect(paired.status).toBe(200)
    expect((await call('GET', '/api/auth/session', { token: String(paired.body.token) })).status).toBe(403)
  })
})

describe('managing people', () => {
  async function ownerToken(): Promise<string> {
    const account = await accounts.findAccount('owner')
    const issued = await accounts.issueCode({ purpose: 'client', accountId: account?.id ?? '' })
    return String((await call('POST', '/api/auth/pair', { body: { code: issued.code } })).body.token)
  }

  it('invites a person who then signs up with the code', async () => {
    const owner = await ownerToken()
    const invite = await call('POST', '/api/auth/codes', { token: owner, body: { purpose: 'invite', role: 'admin' } })
    expect(invite.status).toBe(201)
    const joined = await call('POST', '/api/auth/invite', { body: { code: invite.body.code, login: 'ada', name: 'Ada', password: PASSWORD } })
    expect(joined.status).toBe(201)
    expect(joined.body.account).toMatchObject({ login: 'ada', role: 'admin' })
    expect(joined.cookie).toContain('tnega_token=tnk_')
  })

  it('lets an admin manage members but not owners or admins', async () => {
    const issued = await accounts.issueCode({ purpose: 'invite', role: 'admin' })
    const admin = await call('POST', '/api/auth/invite', { body: { code: issued.code, login: 'adm', password: PASSWORD } })
    const cookie = (admin.cookie ?? '').split(';')[0] ?? ''
    expect((await call('POST', '/api/auth/codes', { cookie, body: { purpose: 'invite', role: 'admin' } })).status).toBe(403)
    const created = await call('POST', '/api/auth/users', { cookie, body: { login: 'newbie', password: PASSWORD } })
    expect(created.status).toBe(201)
    const newbie = created.body.user
    const id = typeof newbie === 'object' && newbie !== null && 'id' in newbie ? String(newbie.id) : ''
    expect((await call('PATCH', `/api/auth/users?id=${id}`, { cookie, body: { disabled: true } })).body.user).toMatchObject({ disabled: true })
    expect((await call('PATCH', `/api/auth/users?id=${id}`, { cookie, body: { role: 'admin' } })).status).toBe(403)
    const owner = await accounts.findAccount('owner')
    expect((await call('PATCH', `/api/auth/users?id=${owner?.id ?? ''}`, { cookie, body: { disabled: true } })).status).toBe(403)
    const list = await call('GET', '/api/auth/users', { cookie })
    expect(Array.isArray(list.body.users)).toBe(true)
  })

  it('changes a password only with the current one', async () => {
    const issued = await accounts.issueCode({ purpose: 'invite' })
    const joined = await call('POST', '/api/auth/invite', { body: { code: issued.code, login: 'pat', password: PASSWORD } })
    const cookie = (joined.cookie ?? '').split(';')[0] ?? ''
    expect((await call('PUT', '/api/auth/password', { cookie, body: { current: 'wrong one', next: 'another long password' } })).status).toBe(401)
    expect((await call('PUT', '/api/auth/password', { cookie, body: { current: PASSWORD, next: 'another long password' } })).status).toBe(200)
    // This browser stays signed in.
    expect((await call('GET', '/api/auth/session', { cookie })).status).toBe(200)
  })
})

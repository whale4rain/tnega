import { X509Certificate } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { createRootCertificate, hostAllowed, issueHostCertificate, startEgressProxy, tokenPolicies, type EgressProxy, type KeyPairPem } from '../src/index.js'

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const basic = (token: string): string => `Basic ${Buffer.from(`box:${token}`).toString('base64')}`

/** A real HTTPS origin, its certificate from a root only the proxy (and some tests) trust. */
async function origin(host: string, root: KeyPairPem) {
  const leaf = issueHostCertificate(root, host)
  const seen: IncomingHttpHeaders[] = []
  const server = createHttpsServer({ cert: leaf.certificatePem, key: leaf.keyPem }, (req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  closers.push(() => new Promise<void>(done => server.close(() => done())))
  return { port: (server.address() as AddressInfo).port, seen }
}

interface Setup {
  proxy: EgressProxy
  originPort: number
  seen: IncomingHttpHeaders[]
  originRoot: KeyPairPem
}

async function setup(trustOrigin = true): Promise<Setup> {
  const originRoot = createRootCertificate('test origin root')
  const { port, seen } = await origin('api.example.com', originRoot)
  const proxy = await startEgressProxy({ host: '127.0.0.1', port: 0 }, {
    root: createRootCertificate(),
    policy: tokenPolicies([
      ['agent-token', {
        name: 'box-1/agent',
        allow: ['plain.example.com'],
        credentials: [{ host: 'api.example.com', headers: { Authorization: 'Bearer real-key' } }],
      }],
    ]),
    ...(trustOrigin ? { trust: [originRoot.certificatePem] } : {}),
    credentialPort: port,
    resolve: async () => ['127.0.0.1'],
    localAddresses: () => new Set(),
  })
  closers.push(() => proxy.close())
  return { proxy, originPort: port, seen, originRoot }
}

/** CONNECT through the proxy; resolves with the tunnel or the proxy's refusal. */
function connect(proxy: EgressProxy, target: string, token?: string): Promise<{ socket: Socket } | { status: number; body: string }> {
  const address = proxy.address as { host: string; port: number }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: address.host, port: address.port, method: 'CONNECT', path: target, headers: token ? { 'proxy-authorization': basic(token) } : {} })
    req.once('connect', (res, socket, head) => {
      if (res.statusCode === 200) { resolve({ socket }); return }
      let body = head.toString()
      socket.on('data', chunk => { body += chunk.toString() })
      socket.once('end', () => resolve({ status: res.statusCode ?? 0, body }))
      socket.once('close', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.once('error', reject)
    req.end()
  })
}

/** One HTTPS request over an open tunnel. */
function get(socket: Socket, servername: string, ca: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername, ca })
    secure.once('error', reject)
    secure.once('secureConnect', () => {
      const req = httpRequest({ createConnection: () => secure, method: 'GET', path: '/v1/me', headers: { connection: 'close', ...headers } })
      req.once('response', res => {
        let body = ''
        res.on('data', chunk => { body += chunk.toString() })
        res.once('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.once('error', reject)
      req.end()
    })
  })
}

describe('certificates', () => {
  it('issues a root and host certificates that verify and name the host', () => {
    const root = createRootCertificate('tnega test root')
    const ca = new X509Certificate(root.certificatePem)
    expect(ca.ca).toBe(true)
    expect(ca.subject).toContain('tnega test root')
    for (const host of ['api.example.com', '10.0.0.7']) {
      const leaf = new X509Certificate(issueHostCertificate(root, host).certificatePem)
      expect(leaf.ca).toBe(false)
      expect(leaf.verify(ca.publicKey)).toBe(true)
      expect(leaf.checkIssued(ca)).toBe(true)
      expect(host.includes('.') && /\d$/u.test(host) ? leaf.checkIP(host) : leaf.checkHost(host)).toBe(host)
    }
  })
})

describe('egress proxy', () => {
  it('adds the key to HTTPS requests for its host and replaces the one the box sent', async () => {
    const { proxy, originPort, seen } = await setup()
    const tunnel = await connect(proxy, `api.example.com:${originPort}`, 'agent-token')
    if (!('socket' in tunnel)) throw new Error(`refused: ${tunnel.status} ${tunnel.body}`)
    const response = await get(tunnel.socket, 'api.example.com', proxy.caCertificate, { host: `api.example.com:${originPort}`, authorization: 'Bearer from-the-box' })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ path: '/v1/me', authorization: 'Bearer real-key' })
    expect(seen).toHaveLength(1)
  })

  it('never sends the key when the request names another host', async () => {
    const { proxy, originPort, seen } = await setup()
    const tunnel = await connect(proxy, `api.example.com:${originPort}`, 'agent-token')
    if (!('socket' in tunnel)) throw new Error('refused')
    const response = await get(tunnel.socket, 'api.example.com', proxy.caCertificate, { host: 'evil.example.net' })
    expect(response.status).toBe(421)
    expect(seen).toHaveLength(0)
  })

  it('never sends the key to a host whose certificate it cannot verify', async () => {
    const { proxy, originPort, seen } = await setup(false)
    const tunnel = await connect(proxy, `api.example.com:${originPort}`, 'agent-token')
    if (!('socket' in tunnel)) throw new Error('refused')
    const response = await get(tunnel.socket, 'api.example.com', proxy.caCertificate, { host: 'api.example.com' })
    expect(response.status).toBe(502)
    expect(response.body).toMatch(/could not reach api\.example\.com/)
    expect(seen).toHaveLength(0)
  })

  it('tunnels an allowed host without a key untouched: the box sees the real certificate', async () => {
    const { proxy, originPort, originRoot } = await setup()
    const tunnel = await connect(proxy, `plain.example.com:${originPort}`, 'agent-token')
    if (!('socket' in tunnel)) throw new Error('refused')
    // Trusting only the origin's root works, so the proxy did not open this TLS.
    await expect(get(tunnel.socket, 'api.example.com', originRoot.certificatePem, { host: 'plain.example.com' }))
      .resolves.toMatchObject({ status: 200 })
  })

  it('refuses a client without a valid token and a host the policy does not name', async () => {
    const { proxy, originPort } = await setup()
    expect(await connect(proxy, `api.example.com:${originPort}`)).toMatchObject({ status: 403, body: expect.stringMatching(/no valid proxy token/) })
    expect(await connect(proxy, `api.example.com:${originPort}`, 'wrong')).toMatchObject({ status: 403 })
    expect(await connect(proxy, 'other.example.org:443', 'agent-token')).toMatchObject({ status: 403, body: expect.stringMatching(/not in this box's allowed hosts/) })
  })

  it('never adds a key to plain HTTP', async () => {
    const seen: IncomingHttpHeaders[] = []
    const plain = createHttpServer((req, res) => { seen.push(req.headers); res.end('ok') })
    await new Promise<void>(done => plain.listen(0, '127.0.0.1', done))
    closers.push(() => new Promise<void>(done => plain.close(() => done())))
    const port = (plain.address() as AddressInfo).port
    const proxy = await startEgressProxy({ host: '127.0.0.1', port: 0 }, {
      root: createRootCertificate(),
      policy: tokenPolicies([['t', { name: 'box', allow: [], credentials: [{ host: 'api.example.com', headers: { authorization: 'Bearer real-key' } }] }]]),
      resolve: async () => ['127.0.0.1'],
      localAddresses: () => new Set(),
    })
    closers.push(() => proxy.close())
    const address = proxy.address as { host: string; port: number }
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: address.host, port: address.port, path: `http://api.example.com:${port}/`, headers: { 'proxy-authorization': basic('t') } }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.once('error', reject)
      req.end()
    })
    expect(status).toBe(200)
    expect(seen[0]?.authorization).toBeUndefined()
  })
})

describe('host patterns', () => {
  it('matches exact names and subdomains, never the apex for a wildcard', () => {
    expect(hostAllowed('github.com', ['github.com'])).toBe(true)
    expect(hostAllowed('api.github.com', ['*.github.com'])).toBe(true)
    expect(hostAllowed('a.b.github.com', ['*.github.com'])).toBe(true)
    expect(hostAllowed('github.com', ['*.github.com'])).toBe(false)
    expect(hostAllowed('evilgithub.com', ['*.github.com'])).toBe(false)
  })
})

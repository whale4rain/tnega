import { createServer, request, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bypassesUpstream,
  isLocalAddress,
  parseUpstreamProxy,
  startNetworkProxy,
  type NetworkProxy,
  type ProxyDecision,
  type ProxyTarget,
  type ProxyVerdict,
} from '../src/index.js'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** A plain HTTP origin on loopback that echoes the path and Host header. */
async function origin(): Promise<number> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`origin ${req.url ?? ''} host=${req.headers.host ?? ''}`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('origin server has no TCP address')
  return address.port
}

/** Allows `allowed.test` (named) and `*.wild.test` (wildcard); both resolve to loopback. */
function rules(target: ProxyTarget): ProxyVerdict {
  if (target.host === 'allowed.test' || target.host === '127.0.0.1') return { allowed: true, reason: 'allowed', rule: target.host, named: true }
  if (target.host.endsWith('.wild.test')) return { allowed: true, reason: 'allowed', rule: '*.wild.test', named: false }
  return { allowed: false, reason: 'not-allowed' }
}

async function proxy(options: { upstream?: string; decisions?: ProxyDecision[]; listen?: { path: string } } = {}): Promise<NetworkProxy> {
  const started = await startNetworkProxy(options.listen ?? { host: '127.0.0.1', port: 0 }, {
    decide: rules,
    resolve: async () => ['127.0.0.1'],
    ...(options.upstream ? { upstream: () => options.upstream } : {}),
    onDecision: decision => options.decisions?.push(decision),
  })
  cleanup.push(() => started.close())
  return started
}

function portOf(started: NetworkProxy): number {
  if (!('port' in started.address)) throw new Error('expected a TCP proxy')
  return started.address.port
}

/** GET through the proxy as an absolute-URI request. */
function plainGet(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET', headers: { host: new URL(url).host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** CONNECT through the proxy, then speak HTTP/1.0 in the tunnel. */
function tunnelGet(connectTo: { port: number } | { path: string }, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ ...('path' in connectTo ? { socketPath: connectTo.path } : { host: '127.0.0.1', port: connectTo.port }), method: 'CONNECT', path: target })
    req.on('connect', (res, socket: Socket) => {
      if (res.statusCode !== 200) {
        let body = ''
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => { body += chunk })
        socket.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        socket.on('error', () => resolve({ status: res.statusCode ?? 0, body }))
        return
      }
      let text = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => { text += chunk })
      socket.on('end', () => resolve({ status: 200, body: text }))
      socket.write(`GET /tunnel HTTP/1.0\r\nHost: ${target}\r\n\r\n`)
    })
    req.on('error', reject)
    req.end()
  })
}

/** A SOCKS5 CONNECT by domain name; resolves with the server's reply code. */
function socksConnect(proxyPort: number, host: string, port: number): Promise<{ reply: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: proxyPort })
    let stage = 0
    let buffered = Buffer.alloc(0)
    let body = ''
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      if (stage === 2) {
        body += chunk.toString('utf8')
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      if (stage === 0 && buffered.length >= 2) {
        buffered = buffered.subarray(2)
        stage = 1
        const name = Buffer.from(host)
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]))
      }
      if (stage === 1 && buffered.length >= 10) {
        const reply = buffered[1] ?? 255
        stage = 2
        if (reply !== 0) {
          socket.destroy()
          resolve({ reply, body })
          return
        }
        socket.write(`GET /socks HTTP/1.0\r\nHost: ${host}\r\n\r\n`)
      }
    })
    socket.on('end', () => resolve({ reply: 0, body }))
    socket.write(Buffer.from([5, 1, 0]))
  })
}

describe('network proxy', () => {
  it('tunnels CONNECT to an allowed host and refuses others with a reason', async () => {
    const port = await origin()
    const decisions: ProxyDecision[] = []
    const started = await proxy({ decisions })

    const allowed = await tunnelGet({ port: portOf(started) }, `allowed.test:${port}`)
    expect(allowed.status).toBe(200)
    expect(allowed.body).toContain('origin /tunnel')

    const blocked = await tunnelGet({ port: portOf(started) }, `evil.test:${port}`)
    expect(blocked.status).toBe(403)
    expect(decisions.map(decision => [decision.host, decision.protocol, decision.allowed]))
      .toEqual([['allowed.test', 'connect', true], ['evil.test', 'connect', false]])
    expect(started.denialsSince(0).map(denial => denial.host)).toEqual(['evil.test'])
  })

  it('forwards plain HTTP requests and explains a refusal in the body', async () => {
    const port = await origin()
    const started = await proxy()

    const allowed = await plainGet(portOf(started), `http://allowed.test:${port}/plain?x=1`)
    expect(allowed).toEqual({ status: 200, body: `origin /plain?x=1 host=allowed.test:${port}` })

    const blocked = await plainGet(portOf(started), `http://evil.test:${port}/`)
    expect(blocked.status).toBe(403)
    expect(blocked.body).toContain(`tnega sandbox blocked evil.test:${port}: it is not in the allowed domains`)
  })

  it('refuses a wildcard-allowed name that resolves to a local address', async () => {
    const port = await origin()
    const decisions: ProxyDecision[] = []
    const started = await proxy({ decisions })

    const blocked = await plainGet(portOf(started), `http://api.wild.test:${port}/`)
    expect(blocked.status).toBe(403)
    expect(blocked.body).toContain('resolves to a local address')
    expect(decisions.at(-1)).toMatchObject({ host: 'api.wild.test', allowed: false, reason: 'local-address', rule: '*.wild.test' })
  })

  it('forwards the Host the filter checked, not the one the client sent', async () => {
    const port = await origin()
    const started = await proxy()
    const response = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: portOf(started), path: `http://allowed.test:${port}/h`, headers: { host: 'other.test' } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.end()
    })
    expect(response).toBe(`origin /h host=allowed.test:${port}`)
  })

  it('refuses local IP literals that only a wildcard allowed, also through an upstream', async () => {
    const port = await origin()
    const upstream = await proxy()
    const any = await startNetworkProxy({ host: '127.0.0.1', port: 0 }, {
      decide: () => ({ allowed: true, reason: 'allowed', rule: '*', named: false }),
      upstream: () => `http://127.0.0.1:${portOf(upstream)}`,
    })
    cleanup.push(() => any.close())
    expect((await tunnelGet({ port: portOf(any) }, `127.0.0.1:${port}`)).status).toBe(403)
    expect((await tunnelGet({ port: portOf(any) }, `[0:0:0:0:0:0:0:1]:${port}`)).status).toBe(403)
    expect((await tunnelGet({ port: portOf(any) }, `localhost:${port}`)).status).toBe(403)
    expect((await plainGet(portOf(any), `http://127.0.0.1:${port}/`)).status).toBe(403)
  })

  it('speaks SOCKS5 on the same port', async () => {
    const port = await origin()
    const started = await proxy()

    const allowed = await socksConnect(portOf(started), 'allowed.test', port)
    expect(allowed.reply).toBe(0)
    expect(allowed.body).toContain('origin /socks')

    // 0x02: connection not allowed by ruleset.
    expect((await socksConnect(portOf(started), 'evil.test', port)).reply).toBe(2)
  })

  it('chains allowed connections through the upstream proxy', async () => {
    const port = await origin()
    const upstreamDecisions: ProxyDecision[] = []
    const upstream = await proxy({ decisions: upstreamDecisions })
    const started = await proxy({ upstream: `http://127.0.0.1:${portOf(upstream)}` })

    expect((await tunnelGet({ port: portOf(started) }, `allowed.test:${port}`)).body).toContain('origin /tunnel')
    expect((await plainGet(portOf(started), `http://allowed.test:${port}/via`)).body).toContain('origin /via')
    // The filter decides first: a refused host never reaches the upstream.
    expect((await tunnelGet({ port: portOf(started) }, `evil.test:${port}`)).status).toBe(403)
    expect(upstreamDecisions.map(decision => [decision.host, decision.protocol])).toEqual([
      ['allowed.test', 'connect'],
      ['allowed.test', 'http'],
    ])
  })

  it.skipIf(process.platform === 'win32')('listens on a Unix socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnega-proxy-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const port = await origin()
    const path = join(dir, 'proxy.sock')
    await proxy({ listen: { path } })

    expect((await tunnelGet({ path }, `allowed.test:${port}`)).body).toContain('origin /tunnel')
  })
})

describe('proxy helpers', () => {
  it('recognises local addresses but not private networks', () => {
    for (const address of ['127.0.0.1', '127.5.0.1', '0.0.0.0', '169.254.169.254', '224.0.0.1', '::1', '::', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'ff02::1',
      '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:ffff:7f00:1', 'FE80:0:0:0:0:0:0:1', '::1%lo']) {
      expect(isLocalAddress(address), address).toBe(true)
    }
    for (const address of ['10.0.0.1', '192.168.1.1', '198.18.0.5', '8.8.8.8', '2606:4700::1111', 'fd00::1', 'not-an-ip']) {
      expect(isLocalAddress(address), address).toBe(false)
    }
  })

  it('parses http upstreams with credentials and refuses other schemes', () => {
    expect(parseUpstreamProxy('http://127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
    expect(parseUpstreamProxy('http://me:secret@proxy.example:8080')).toEqual({
      host: 'proxy.example',
      port: 8080,
      authorization: `Basic ${Buffer.from('me:secret').toString('base64')}`,
    })
    expect(() => parseUpstreamProxy('socks5://127.0.0.1:1080')).toThrow(/http:\/\/ proxy/)
  })

  it('matches NO_PROXY by suffix and exact IP', () => {
    expect(bypassesUpstream('a.internal.example', '.internal.example,10.0.0.1')).toBe(true)
    expect(bypassesUpstream('internal.example', 'internal.example')).toBe(true)
    expect(bypassesUpstream('10.0.0.1', 'internal.example,10.0.0.1')).toBe(true)
    expect(bypassesUpstream('example.com', 'internal.example')).toBe(false)
    expect(bypassesUpstream('anything', '*')).toBe(true)
    expect(bypassesUpstream('anything', undefined)).toBe(false)
  })
})

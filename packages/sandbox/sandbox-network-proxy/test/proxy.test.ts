import { createServer, request, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bypassesUpstream,
  isLocalAddress,
  ownAddresses,
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

async function proxy(options: { upstream?: string; decisions?: ProxyDecision[]; listen?: { path: string }; resolve?: () => Promise<string[]>; local?: ReadonlySet<string> } = {}): Promise<NetworkProxy> {
  const started = await startNetworkProxy(options.listen ?? { host: '127.0.0.1', port: 0 }, {
    decide: rules,
    resolve: options.resolve ?? (async () => ['127.0.0.1']),
    ...(options.local ? { localAddresses: () => options.local as ReadonlySet<string> } : {}),
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

/** An origin that accepts a WebSocket-style upgrade, greets, and echoes what it is sent. */
async function upgradeOrigin(): Promise<number> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`origin ${req.url ?? ''} host=${req.headers.host ?? ''} upgrade=${req.headers.upgrade ?? 'none'}`)
  })
  // 升级后的连接不会自己结束，得由测试收尾时切断，否则 server.close() 一直等它们。
  const live = new Set<Socket>()
  server.on('connection', socket => {
    live.add(socket)
    socket.once('close', () => live.delete(socket))
  })
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write(`reached ${req.url ?? ''} host=${req.headers.host ?? ''}\n`)
    socket.on('data', chunk => socket.write(chunk))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => {
    for (const socket of live) socket.destroy()
    live.clear()
    return new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('origin server has no TCP address')
  return address.port
}

/** Send an upgrade through the proxy and, if it is accepted, check the tunnel echoes. */
function upgradeThrough(proxyPort: number, target: string, path = '/ws'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: proxyPort })
    let text = ''
    let opened = false
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (!opened) {
        if (!text.includes('\r\n\r\n')) return
        opened = true
        const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(text)?.[1] ?? 0)
        if (status !== 101) {
          socket.destroy()
          resolve({ status, text })
          return
        }
        socket.write('ping-through')
        return
      }
      if (text.includes('ping-through')) {
        socket.destroy()
        resolve({ status: 101, text })
      }
    })
    socket.setTimeout(5000, () => { socket.destroy(); resolve({ status: 0, text: `${text} (timed out)` }) })
    socket.write(`GET http://${target}${path} HTTP/1.1\r\nHost: ${target}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n`)
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

  it('does not resolve a host it is about to refuse', async () => {
    // 解析会把主机名送给 DNS 服务器。判定必须排在它前面，否则被拒的名字照样泄露。
    const resolved: string[] = []
    const started = await startNetworkProxy({ host: '127.0.0.1', port: 0 }, {
      decide: rules,
      resolve: async (host) => { resolved.push(host); return ['93.184.216.34'] },
    })
    cleanup.push(() => started.close())

    expect((await tunnelGet({ port: portOf(started) }, 'evil.test:443')).status).toBe(403)
    expect((await plainGet(portOf(started), 'http://evil.test/')).status).toBe(403)
    expect((await socksConnect(portOf(started), 'evil.test', 443)).reply).toBe(2)
    expect(resolved).toEqual([])
  })

  it('carries an upgrade request through to the origin instead of answering it itself', async () => {
    const port = await upgradeOrigin()
    const decisions: ProxyDecision[] = []
    const started = await proxy({ decisions })

    const upgraded = await upgradeThrough(portOf(started), `allowed.test:${port}`)
    expect(upgraded.status).toBe(101)
    // Host 仍然是被判定过的那个，而不是客户端自己写的别的名字。
    expect(upgraded.text).toContain(`reached /ws host=allowed.test:${port}`)
    // 握手之后两个方向都能走字节：这条连接不能被当成一次性请求用。
    expect(upgraded.text).toContain('ping-through')
    expect(decisions.at(-1)).toMatchObject({ host: 'allowed.test', protocol: 'upgrade', allowed: true })
  })

  it('refuses an upgrade to a host the rules deny', async () => {
    const port = await upgradeOrigin()
    const started = await proxy()

    const blocked = await upgradeThrough(portOf(started), `evil.test:${port}`)
    expect(blocked.status).toBe(403)
    expect(blocked.text).toContain('tnega sandbox blocked evil.test')
  })

  it('refuses a wildcard-allowed name that resolves to one of the host\'s own interfaces', async () => {
    const decisions: ProxyDecision[] = []
    // 本机网卡地址：一个绑在 0.0.0.0 的服务在它上面与回环等价。
    const started = await proxy({ decisions, resolve: async () => ['192.168.1.10'], local: new Set(['192.168.1.10']) })
    const blocked = await tunnelGet({ port: portOf(started) }, 'api.wild.test:3000')
    expect(blocked.status).toBe(403)
    expect(decisions.at(-1)).toMatchObject({ host: 'api.wild.test', allowed: false, reason: 'local-address' })
    // 逐字点名的规则跳过这项检查，所以加进允许表就能恢复。
    const named = await proxy({ resolve: async () => ['192.168.1.10'], local: new Set(['192.168.1.10']) })
    const allowed = await tunnelGet({ port: portOf(named) }, `127.0.0.1:${1}`)
    expect(allowed.status).not.toBe(403)
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

  it('refuses wildcard names that resolve to a local address before using the upstream', async () => {
    const port = await origin()
    const upstream = await proxy()
    const started = await proxy({ upstream: `http://127.0.0.1:${portOf(upstream)}` })
    expect((await tunnelGet({ port: portOf(started) }, `api.wild.test:${port}`)).status).toBe(403)
    expect((await plainGet(portOf(started), `http://api.wild.test:${port}/`)).status).toBe(403)
    expect((await socksConnect(portOf(started), 'api.wild.test', port)).reply).toBe(2)

    // A name only the upstream can resolve still goes to the upstream.
    const upstreamDecisions: ProxyDecision[] = []
    const resolver = await proxy({ decisions: upstreamDecisions })
    const blind = await startNetworkProxy({ host: '127.0.0.1', port: 0 }, {
      decide: rules,
      resolve: async () => { throw new Error('ENOTFOUND') },
      upstream: () => `http://127.0.0.1:${portOf(resolver)}`,
    })
    cleanup.push(() => blind.close())
    await tunnelGet({ port: portOf(blind) }, `api.wild.test:${port}`)
    expect(upstreamDecisions.map(decision => decision.host)).toEqual(['api.wild.test'])
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
    // 显式传一个空的「本机网卡」集：这条测的是网段规则，不该随跑测试的机器变。
    const none = new Set<string>()
    for (const address of ['127.0.0.1', '127.5.0.1', '0.0.0.0', '169.254.169.254', '224.0.0.1', '::1', '::', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'ff02::1',
      '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:ffff:7f00:1', 'FE80:0:0:0:0:0:0:1', '::1%lo']) {
      expect(isLocalAddress(address, none), address).toBe(true)
    }
    // 不在 link-local 段里的云平台端点。
    for (const address of ['100.100.100.200', '168.63.129.16', '192.0.0.192',
      'fd00:ec2::254', 'fd20:ce::254', 'fd00:c1::a9fe:a9fe', 'fd00:42::42', '::ffff:100.100.100.200']) {
      expect(isLocalAddress(address, none), address).toBe(true)
    }
    for (const address of ['10.0.0.1', '192.168.1.1', '198.18.0.5', '8.8.8.8', '2606:4700::1111', 'fd00::1', 'not-an-ip']) {
      expect(isLocalAddress(address, none), address).toBe(false)
    }
  })

  it('counts the host\'s own interface addresses as local', () => {
    const own = new Set(['192.168.1.10', 'fd00::1'])
    expect(isLocalAddress('192.168.1.10', own)).toBe(true)
    expect(isLocalAddress('fd00::1', own)).toBe(true)
    expect(isLocalAddress('192.168.1.11', own)).toBe(false)
    // 这个包没有本机接口列表时，就是机器的真实网卡。
    expect(ownAddresses().size).toBeGreaterThan(0)
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

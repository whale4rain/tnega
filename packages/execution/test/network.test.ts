import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { configureNetwork, isAllowedHost, localExecutionProvider, networkFetch } from '../src/index.js'

const servers: Server[] = []
afterEach(async () => {
  configureNetwork({})
  delete process.env.HTTPS_PROXY
  delete process.env.HTTP_PROXY
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

/** A forward proxy that answers every request itself, recording what it was asked for. */
async function proxy(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.headers.host ?? ''}${req.url ?? ''}`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('via proxy')
  })
  // Proxied requests arrive as a CONNECT tunnel; serve the tunnelled request here too.
  server.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    server.emit('connection', socket)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { url: `http://127.0.0.1:${address.port}`, seen }
}

describe('network policy', () => {
  it('preserves POST bodies and headers through the configured proxy', async () => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization }))
    })
    server.on('connect', (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      server.emit('connection', socket)
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    configureNetwork({ proxy: `http://127.0.0.1:${address.port}` })
    const result = await networkFetch(new URL('http://auth.example.test/token'), {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{"grant_type":"refresh_token"}',
    })
    expect(await result.json()).toEqual({ method: 'POST', body: '{"grant_type":"refresh_token"}', authorization: 'Bearer fixture' })
  })
  it('matches allowed hosts exactly or by subdomain wildcard', () => {
    expect(isAllowedHost('raw.githubusercontent.com')).toBe(true)
    expect(isAllowedHost('GitHub.com.')).toBe(true)
    expect(isAllowedHost('evilgithub.com')).toBe(false)
    expect(isAllowedHost('docs.example.org', ['*.example.org'])).toBe(true)
    expect(isAllowedHost('example.org', ['*.example.org'])).toBe(true)
    expect(isAllowedHost('example.org', ['other.org'])).toBe(false)
  })

  it('routes requests through the configured proxy and trusts allowed hosts whatever DNS says', async () => {
    const { url, seen } = await proxy()
    configureNetwork({ proxy: url, allowedHosts: ['skills.example.test'] })
    const response = await localExecutionProvider.fetchHttp({ url: 'http://skills.example.test/SKILL.md' })
    expect(response).toMatchObject({ status: 200, body: 'via proxy' })
    expect(seen).toEqual(['skills.example.test/SKILL.md'])
  })

  it('follows HTTPS_PROXY / HTTP_PROXY from the environment', async () => {
    const { url, seen } = await proxy()
    process.env.HTTP_PROXY = url
    configureNetwork({ allowedHosts: ['env.example.test'] })
    expect((await localExecutionProvider.fetchHttp({ url: 'http://env.example.test/a' })).body).toBe('via proxy')
    expect(seen).toEqual(['env.example.test/a'])
  })

  it('explains DNS failures, reserved addresses and unreachable hosts', async () => {
    await expect(localExecutionProvider.fetchHttp({ url: 'https://no-such-host.invalid/x' }))
      .rejects.toThrow(/DNS lookup for no-such-host\.invalid failed/)
    await expect(localExecutionProvider.fetchHttp({ url: 'https://198.18.0.7/x' }))
      .rejects.toThrow(/resolves to 198\.18\.0\.7, a private or reserved address\. This is how a proxy in fake-IP mode answers DNS/)
    configureNetwork({ proxy: 'http://127.0.0.1:9', allowedHosts: ['down.example.test'] })
    await expect(localExecutionProvider.fetchHttp({ url: 'http://down.example.test/' }))
      .rejects.toThrow(/could not reach down\.example\.test: .*ECONNREFUSED.*through the configured proxy/)
  })
})

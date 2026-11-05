import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { MachineError, type BoxSpec } from '@tnega/machine'
import { BOX_START_SCRIPT, e2bDomain, E2BMachines, LAUNCH_COMMAND, MACHINE_KEY_METADATA, type DaemonLauncher } from '../src/index.js'

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: unknown }
interface FakeSandbox { sandboxID: string; state: 'running' | 'paused'; metadata: Record<string, string> }

const closers: Array<() => Promise<void>> = []

/** Records each daemon start instead of calling E2B's command API. */
let launcher: { launch: DaemonLauncher; launched: Array<{ ref: string; env: Readonly<Record<string, string>> }> }
beforeEach(() => {
  const launched: Array<{ ref: string; env: Readonly<Record<string, string>> }> = []
  launcher = { launched, launch: async (ref, env) => { launched.push({ ref, env }) } }
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

/** A small stand-in for E2B's REST API, enough for the calls the Provider makes. */
async function fakeE2B(options: { ignoreMetadataFilter?: boolean } = {}) {
  const sandboxes = new Map<string, FakeSandbox>()
  const seen: Seen[] = []
  let next = 1
  // E2B replays a create with a key it has seen, even after that sandbox is gone.
  const replays = new Map<string, string>()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk.toString() })
    req.on('end', () => {
      const body: unknown = raw ? JSON.parse(raw) : undefined
      const url = new URL(req.url ?? '/', 'http://fake')
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const json = (status: number, value?: unknown): void => {
        res.writeHead(status, value === undefined ? {} : { 'content-type': 'application/json' })
        res.end(value === undefined ? undefined : JSON.stringify(value))
      }
      if (req.headers['x-api-key'] !== 'e2b_test') { json(401, { code: 401, message: 'Invalid API key' }); return }
      const one = /^\/(?:v2\/)?sandboxes\/([^/]+)(\/pause|\/connect)?$/u.exec(url.pathname)
      if (req.method === 'GET' && url.pathname === '/v2/sandboxes') {
        const filter = new URLSearchParams(url.searchParams.get('metadata') ?? '')
        const states = (url.searchParams.get('state') ?? '').split(',')
        const list = [...sandboxes.values()].filter(sandbox =>
          states.includes(sandbox.state) && (options.ignoreMetadataFilter || [...filter].every(([k, v]) => sandbox.metadata[k] === v)))
        json(200, list.map(sandbox => ({ ...sandbox, templateID: 'tnega', clientID: 'c', cpuCount: 2, memoryMB: 2048 })))
        return
      }
      if (req.method === 'POST' && url.pathname === '/v2/sandboxes') {
        const metadata: Record<string, string> = {}
        if (typeof body === 'object' && body !== null && 'metadata' in body && typeof body.metadata === 'object' && body.metadata !== null) {
          for (const [name, value] of Object.entries(body.metadata)) if (typeof value === 'string') metadata[name] = value
        }
        const idempotency = req.headers['idempotency-key']
        const replayed = typeof idempotency === 'string' ? replays.get(idempotency) : undefined
        if (replayed) { json(201, { sandboxID: replayed }); return }
        const sandboxID = `sbx${next++}`
        if (typeof idempotency === 'string') replays.set(idempotency, sandboxID)
        sandboxes.set(sandboxID, { sandboxID, state: 'running', metadata })
        json(201, { sandboxID, templateID: 'tnega', clientID: 'c', envdVersion: '0.2.0' })
        return
      }
      if (!one) { json(404, { message: 'no route' }); return }
      const sandbox = sandboxes.get(one[1] ?? '')
      if (!sandbox) { json(404, { code: 404, message: 'sandbox not found' }); return }
      if (req.method === 'GET' && !one[2]) { json(200, { ...sandbox }); return }
      if (req.method === 'DELETE' && !one[2]) { sandboxes.delete(sandbox.sandboxID); json(204); return }
      if (req.method === 'POST' && one[2] === '/pause') {
        if (sandbox.state === 'paused') { json(409, { message: 'already paused' }); return }
        sandbox.state = 'paused'
        json(204)
        return
      }
      if (req.method === 'POST' && one[2] === '/connect') { sandbox.state = 'running'; json(201, { sandboxID: sandbox.sandboxID }); return }
      json(405)
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  closers.push(() => new Promise<void>(done => server.close(() => done())))
  return { apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sandboxes, seen }
}

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'

function spec(network: BoxSpec['network'] = { mode: 'egress', egress: { proxyUrl: 'http://10.0.0.2:3128', proxyAddresses: ['10.0.0.2'], token: 'egress-token', caCertificate: CA } }): BoxSpec {
  return {
    template: 'tnega-box',
    daemon: { serverUrl: 'wss://tnega.example.com/daemon', token: 'daemon-token' },
    workspacePath: '/workspace',
    network,
    isolation: 'microvm',
    labels: { project: 'p1' },
  }
}

describe('E2B machines', () => {
  it('creates a box with its env, its key in metadata and a firewall of addresses only: the proxy and the server, no DNS', async () => {
    const api = await fakeE2B()
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7', '2001:db8::1'], apiKey: 'e2b_test', timeoutSeconds: 600 })
    const { ref } = await machines.start('box-1', spec())
    expect(ref).toBe('sbx1')
    const create = api.seen.find(call => call.method === 'POST' && call.url === '/v2/sandboxes')
    expect(create?.headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/u)
    expect(create?.body).toMatchObject({
      templateID: 'tnega-box',
      timeout: 600,
      autoPause: true,
      metadata: { project: 'p1', [MACHINE_KEY_METADATA]: 'box-1' },
      allow_internet_access: false,
      network: { allowOut: ['10.0.0.2', '203.0.113.7'], denyOut: ['0.0.0.0/0'], dnsServers: [] },
    })
    // The box's own environment stays empty: the token goes only to the daemon's start.
    expect(create?.body).not.toHaveProperty('envVars')
    expect(launcher.launched).toEqual([{
      ref: 'sbx1',
      env: expect.objectContaining({
        TNEGA_SERVER: 'wss://tnega.example.com/daemon',
        TNEGA_DAEMON_TOKEN: 'daemon-token',
        HTTPS_PROXY: 'http://box:egress-token@10.0.0.2:3128',
        TNEGA_EGRESS_CA: CA,
        TNEGA_HOSTS: '203.0.113.7 tnega.example.com',
      }),
    }])
  })

  it('makes sure the daemon runs on every start, and reports a daemon that cannot start', async () => {
    const api = await fakeE2B()
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7'], apiKey: 'e2b_test' })
    const { ref } = await machines.start('box-1', spec())
    await machines.pause(ref)
    await machines.start('box-1', spec())
    expect(launcher.launched.map(launch => launch.ref)).toEqual([ref, ref])
    const failing = new E2BMachines(new Context(), {
      launch: async () => { throw new MachineError('could not start the daemon in box sbx2', 'MACHINE_FAILED') },
      apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7'], apiKey: 'e2b_test',
    })
    await expect(failing.start('box-2', spec())).rejects.toMatchObject({ code: 'MACHINE_FAILED' })
  })

  it('starts the daemon only when it is not running, detached, from the template\'s script', () => {
    expect(LAUNCH_COMMAND).toContain("pgrep -f '[t]nega daemon --server'")
    expect(LAUNCH_COMMAND).toContain(`setsid -f ${BOX_START_SCRIPT}`)
    expect(e2bDomain('https://api.e2b.app')).toBe('e2b.app')
    expect(e2bDomain('http://localhost:3000')).toBe('localhost:3000')
  })

  it('finds the same box again and resumes it when it is paused', async () => {
    const api = await fakeE2B()
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7', '2001:db8::1'], apiKey: 'e2b_test' })
    const { ref } = await machines.start('box-1', spec())
    await machines.pause(ref)
    expect(await machines.status(ref)).toBe('paused')
    await machines.pause(ref) // already paused: fine
    expect(await machines.start('box-1', spec())).toEqual({ ref })
    expect(await machines.status(ref)).toBe('running')
    expect(api.sandboxes.size).toBe(1)
    expect(api.seen.filter(call => call.url.endsWith('/connect'))).toHaveLength(1)
  })

  it('stops a box for good and reports it missing; stopping twice is fine', async () => {
    const api = await fakeE2B()
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7', '2001:db8::1'], apiKey: 'e2b_test' })
    const { ref } = await machines.start('box-1', spec())
    await machines.stop(ref)
    await machines.stop(ref)
    expect(await machines.status(ref)).toBe('missing')
    await expect(machines.pause(ref)).resolves.toBeUndefined()
    // The next box gets a new daemon token, so E2B does not replay the deleted sandbox.
    const next = await machines.start('box-1', { ...spec(), daemon: { serverUrl: 'wss://tnega.example.com/daemon', token: 'second-token' } })
    expect(next.ref).not.toBe(ref)
    expect(await machines.status(next.ref)).toBe('running')
  })

  it('opens the network only when asked, and gives a no-network box just the server', async () => {
    const api = await fakeE2B()
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7', '2001:db8::1'], apiKey: 'e2b_test' })
    await machines.start('open', spec({ mode: 'open' }))
    await machines.start('none', spec({ mode: 'none' }))
    const [open, none] = api.seen.filter(call => call.method === 'POST' && call.url === '/v2/sandboxes').map(call => call.body)
    expect(open).toMatchObject({ allow_internet_access: true })
    expect(open).not.toHaveProperty('network')
    expect(launcher.launched[0]?.env).not.toHaveProperty('HTTPS_PROXY')
    expect(none).toMatchObject({ allow_internet_access: false, network: { allowOut: ['203.0.113.7'], denyOut: ['0.0.0.0/0'], dnsServers: [] } })
  })

  it('refuses to reuse a box built from another environment and names it, so its work can be saved first', async () => {
    const api = await fakeE2B()
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7', '2001:db8::1'], apiKey: 'e2b_test' })
    const old = await machines.start('box-1', { ...spec(), specHash: 'v1' })
    await machines.pause(old.ref)
    await expect(machines.start('box-1', { ...spec(), specHash: 'v2' })).rejects.toMatchObject({ code: 'MACHINE_SPEC_CHANGED', ref: old.ref })
    expect(await machines.status(old.ref)).toBe('paused')
    // The server's path: resume with the old spec, save the work, stop, start again.
    expect(await machines.start('box-1', { ...spec(), specHash: 'v1' })).toEqual(old)
    await machines.stop(old.ref)
    const fresh = await machines.start('box-1', { ...spec(), specHash: 'v2', daemon: { serverUrl: 'wss://tnega.example.com/daemon', token: 'v2-token' } })
    expect(fresh.ref).not.toBe(old.ref)
    expect(api.sandboxes.get(fresh.ref)?.metadata).toMatchObject({ tnega_spec_hash: 'v2' })
  })

  it('makes one box when two starts for the same key race, even with different tokens', async () => {
    const api = await fakeE2B()
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7'], apiKey: 'e2b_test' })
    const [first, second] = await Promise.all([
      machines.start('box-1', spec()),
      machines.start('box-1', { ...spec(), daemon: { serverUrl: 'wss://tnega.example.com/daemon', token: 'other-token' } }),
    ])
    expect(second).toEqual(first)
    expect(api.sandboxes.size).toBe(1)
  })

  it('never takes another machine\'s box, even when the API ignores the metadata filter', async () => {
    const api = await fakeE2B({ ignoreMetadataFilter: true })
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7', '2001:db8::1'], apiKey: 'e2b_test' })
    const first = await machines.start('box-1', spec())
    const second = await machines.start('box-2', spec())
    expect(second.ref).not.toBe(first.ref)
  })

  it('maps failures to machine errors and refuses a bad spec before calling E2B', async () => {
    const api = await fakeE2B()
    const wrongKey = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, apiKey: 'nope' })
    await expect(wrongKey.start('box-1', spec())).rejects.toMatchObject({ code: 'MACHINE_UNAVAILABLE', message: expect.stringContaining('Invalid API key') })
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: api.apiUrl, resolve: async () => ['203.0.113.7', '2001:db8::1'], apiKey: 'e2b_test' })
    const calls = api.seen.length
    await expect(machines.start('box-1', { ...spec(), workspacePath: 'workspace' })).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    expect(api.seen).toHaveLength(calls)
    const unreachable = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: 'http://127.0.0.1:1', apiKey: 'e2b_test' })
    await expect(unreachable.status('sbx1')).rejects.toMatchObject({ code: 'MACHINE_UNAVAILABLE' })
  })

  it('gives up on a call E2B never answers', async () => {
    const hanging: typeof globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
    const machines = new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: 'https://e2b.example', apiKey: 'k', fetch: hanging, requestTimeoutMs: 20 })
    await expect(machines.status('sbx1')).rejects.toMatchObject({ code: 'MACHINE_UNAVAILABLE' })
  })

  it('refuses a plain-HTTP API URL to another machine, which would send the key in the clear', () => {
    expect(() => new E2BMachines(new Context(), { launch: launcher.launch, apiUrl: 'http://e2b.internal', apiKey: 'k' })).toThrow(/https/)
  })
})

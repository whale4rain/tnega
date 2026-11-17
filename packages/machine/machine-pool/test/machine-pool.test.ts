import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { Account, AccountService } from '@tnega/accounts'
import { accountsPg } from '@tnega/accounts-pg'
import type { DaemonLink } from '@tnega/daemon-protocol'
import { daemons, type DaemonRegistry } from '@tnega/daemons'
import { createRootCertificate } from '@tnega/egress-proxy'
import { MachineService, type BoxSpec, type MachineRef, type MachineState } from '@tnega/machine'
import { machinePool, MachinePoolError, type MachinePool, type MachinePoolConfig } from '../src/index.js'

/** Which link served each call, by the order links were made: a call never needs an answer here. */
const linkCalls: string[] = []
let links = 0

function fakeLink(deviceId: string): DaemonLink {
  const listeners = new Set<(reason?: string) => void>()
  let closed = false
  const serial = ++links
  return {
    deviceId,
    protocolVersion: 2,
    capabilities: { fs: true, process: true, http: true, platform: 'linux' },
    workspaces: [{ id: 'ws_box', path: '/workspace' }],
    get closed() { return closed },
    call: method => {
      linkCalls.push(`${serial} ${method}`)
      return closed ? Promise.reject(new Error('link closed')) : Promise.reject(new Error('answered'))
    },
    onNotification: () => () => undefined,
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close(reason) {
      if (closed) return
      closed = true
      for (const listener of listeners) listener(reason)
    },
  }
}

interface Box { key: string; spec: BoxSpec; state: MachineState; token: string; link?: DaemonLink }

/**
 * Boxes whose daemon dials back the moment they run: a new box with the token
 * in its spec, a resumed one with the token it had (as a checkpoint would).
 */
class FakeMachines extends MachineService {
  readonly kind = 'fake'
  readonly boxes = new Map<string, Box>()
  readonly calls: string[] = []
  connect = true

  constructor(ctx: Context, private readonly accounts: AccountService, private readonly registry: DaemonRegistry) {
    super(ctx)
  }

  async start(key: string, spec: BoxSpec): Promise<MachineRef> {
    const ref = `box-${key.slice(0, 8)}`
    const box = this.boxes.get(ref)
    this.calls.push(`${box?.state === 'paused' ? 'resume' : box?.state === 'running' ? 'again' : 'start'} ${ref}`)
    const next: Box = box && box.state !== 'missing' ? { ...box, state: 'running' } : { key, spec, state: 'running', token: spec.daemon.token }
    this.boxes.set(ref, next)
    if (this.connect && !next.link?.closed && next.link) return { ref }
    if (this.connect) setTimeout(() => { void this.dial(ref) }, 5)
    return { ref }
  }

  private async dial(ref: string): Promise<void> {
    const box = this.boxes.get(ref)
    if (!box || box.state !== 'running') return
    const principal = await this.accounts.authenticate(box.token)
    if (!principal) return
    box.link = fakeLink(principal.device.id)
    this.registry.add({ deviceId: principal.device.id, accountId: principal.account.id, link: box.link })
  }

  async pause(ref: string): Promise<void> {
    this.calls.push(`pause ${ref}`)
    const box = this.boxes.get(ref)
    if (!box) return
    box.state = 'paused'
    box.link?.close('paused')
  }

  async stop(ref: string): Promise<void> {
    this.calls.push(`stop ${ref}`)
    const box = this.boxes.get(ref)
    box?.link?.close('stopped')
    this.boxes.delete(ref)
  }

  async status(ref: string): Promise<MachineState> {
    return this.boxes.get(ref)?.state ?? 'missing'
  }
}

let db: PGlite
let ctx: Context
let dir: string
let machines: FakeMachines
let accounts: AccountService
let mia: Account

async function openPool(config: Partial<MachinePoolConfig> = {}): Promise<MachinePool> {
  await ctx.plugin(machinePool, {
    sql: db,
    serverUrl: 'ws://10.0.0.5:7777/daemon',
    plainServer: true,
    template: 'tnega-box',
    connectTimeoutMs: 2_000,
    ...config,
  })
  return ctx.get('machinePool')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tnega-pool-'))
  db = new PGlite()
  ctx = new Context()
  await ctx.plugin(accountsPg, { sql: db })
  await ctx.plugin(daemons)
  accounts = ctx.get('accounts')
  machines = new FakeMachines(ctx, accounts, ctx.get('daemons'))
  mia = await accounts.createAccount({ login: 'mia', role: 'member', password: 'correct horse battery' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('machine pool', () => {
  it('starts one box per account and workspace, with a fresh daemon token, and reuses it', async () => {
    const pool = await openPool()
    const lease = await pool.acquire({ accountId: mia.id, workspace: dir, sessionId: 's1' })
    expect(lease.workspacePath).toBe('/workspace')
    const box = [...machines.boxes.values()][0]
    expect(box?.spec).toMatchObject({
      template: 'tnega-box',
      hostWorkspace: dir,
      workspacePath: '/workspace',
      isolation: 'gvisor',
      network: { mode: 'none' },
      env: { TNEGA_DAEMON_ALLOW_WS: '1' },
      daemon: { serverUrl: 'ws://10.0.0.5:7777/daemon' },
    })
    const devices = await accounts.listDevices(mia.id)
    expect(devices.filter(device => device.kind === 'daemon').map(device => device.id)).toEqual([lease.deviceId])
    const again = await pool.acquire({ accountId: mia.id, workspace: dir, sessionId: 's2' })
    expect(again.machineId).toBe(lease.machineId)
    expect(again.link).toBe(lease.link)
    expect(machines.calls).toEqual([`start box-${lease.machineId.slice(0, 8)}`])
    const { rows } = await db.query<{ session_id: string }>('select session_id from machine_session order by session_id')
    expect(rows.map(row => row.session_id)).toEqual(['s1', 's2'])
    lease.release()
    again.release()
  })

  it('pauses a box once it has been idle, and resumes it with the token it already had', async () => {
    const pool = await openPool({ idlePauseMs: 20 })
    const lease = await pool.acquire({ accountId: mia.id, workspace: dir })
    lease.release()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect((await pool.row(lease.machineId))?.state).toBe('paused')
    const back = await pool.acquire({ accountId: mia.id, workspace: dir })
    // The checkpoint's daemon came back with its old token; the new one was revoked.
    expect(back.deviceId).toBe(lease.deviceId)
    const daemonsLeft = (await accounts.listDevices(mia.id)).filter(device => device.kind === 'daemon')
    expect(daemonsLeft.map(device => device.id)).toEqual([lease.deviceId])
    back.release()
  })

  it('pauses the least recently used idle box to stay under the cap, and refuses when all are busy', async () => {
    const pool = await openPool({ maxRunning: 1 })
    const first = await pool.acquire({ accountId: mia.id, workspace: join(dir, 'a') })
    await expect(pool.acquire({ accountId: mia.id, workspace: join(dir, 'b') })).rejects.toBeInstanceOf(MachinePoolError)
    first.release()
    const second = await pool.acquire({ accountId: mia.id, workspace: join(dir, 'b') })
    expect((await pool.row(first.machineId))?.state).toBe('paused')
    expect((await pool.row(second.machineId))?.state).toBe('running')
    second.release()
  })

  it('stops a box whose daemon never connects, and revokes its token', async () => {
    const pool = await openPool({ connectTimeoutMs: 50 })
    machines.connect = false
    await expect(pool.acquire({ accountId: mia.id, workspace: dir })).rejects.toMatchObject({ code: 'DAEMON_TIMEOUT' })
    expect(machines.calls.at(-1)).toMatch(/^stop /)
    expect((await accounts.listDevices(mia.id)).filter(device => device.kind === 'daemon')).toEqual([])
    expect((await pool.list())[0]?.state).toBe('cold')
  })

  it('reclaims boxes nobody used for long: stopped, token revoked, row gone', async () => {
    const pool = await openPool()
    const lease = await pool.acquire({ accountId: mia.id, workspace: dir })
    expect(await pool.reclaim(Date.now() + 8 * 24 * 3_600_000)).toBe(0)
    lease.release()
    expect(await pool.reclaim(Date.now() + 8 * 24 * 3_600_000)).toBe(1)
    expect(await pool.list()).toEqual([])
    expect(await accounts.authenticate('x')).toBeUndefined()
    expect((await accounts.listDevices(mia.id)).filter(device => device.kind === 'daemon')).toEqual([])
    expect(lease.link.closed).toBe(true)
  })

  it('gives an egress box the proxy, its own token and the CA, and the proxy knows that token', async () => {
    const root = createRootCertificate()
    const pool = await openPool({ egress: { listen: { host: '127.0.0.1', port: 0 }, advertise: '10.0.0.5', root, allow: ['registry.npmjs.org'] } })
    const lease = await pool.acquire({ accountId: mia.id, workspace: dir })
    const spec = [...machines.boxes.values()][0]?.spec
    if (spec?.network.mode !== 'egress') throw new Error('expected an egress box')
    expect(spec.network.egress.proxyUrl).toMatch(/^http:\/\/10\.0\.0\.5:\d+$/)
    expect(spec.network.egress.proxyAddresses).toEqual(['10.0.0.5'])
    expect(spec.network.egress.caCertificate).toBe(root.certificatePem)
    expect(pool.egressPolicy(spec.network.egress.token)?.allow).toEqual(['registry.npmjs.org'])
    expect(pool.egressPolicy('someone else')).toBeUndefined()
    lease.release()
    await pool.stop(lease.machineId)
    expect(pool.egressPolicy(spec.network.egress.token)).toBeUndefined()
  })
})

describe('machine pool keys', () => {
  it('sends a remembered GITHUB_TOKEN to GitHub through the proxy, and reads keys again on resume', async () => {
    const root = createRootCertificate()
    const secrets: Record<string, string> = {}
    const pool = await openPool({
      egress: { listen: { host: '127.0.0.1', port: 0 }, advertise: '10.0.0.5', root, allow: ['registry.npmjs.org'] },
      rememberedSecrets: async () => ({ ...secrets }),
    })
    const lease = await pool.acquire({ accountId: mia.id, workspace: dir })
    const spec = [...machines.boxes.values()][0]?.spec
    if (spec?.network.mode !== 'egress') throw new Error('expected an egress box')
    expect(spec.env?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(pool.egressPolicy(spec.network.egress.token)?.credentials).toEqual([])
    lease.release()
    await pool.pause(lease.machineId)

    secrets.GITHUB_TOKEN = 'ghp_example'
    const again = await pool.acquire({ accountId: mia.id, workspace: dir })
    const credentials = pool.egressPolicy(spec.network.egress.token)?.credentials ?? []
    expect(credentials.map(credential => credential.host)).toEqual(['github.com', 'api.github.com'])
    expect(credentials[0]?.headers.authorization).toBe(`Basic ${Buffer.from('x-access-token:ghp_example').toString('base64')}`)
    expect(credentials[1]?.headers.authorization).toBe('Bearer ghp_example')
    again.release()
  })
})

describe('machine pool scopes', () => {
  it('gives each Project thread of a workspace its own box', async () => {
    const pool = await openPool()
    const own = await pool.acquire({ accountId: mia.id, workspace: dir })
    const thread = await pool.acquire({ accountId: mia.id, workspace: dir, scope: 'thread:t1' })
    const other = await pool.acquire({ accountId: mia.id, workspace: dir, scope: 'thread:t2' })
    expect(new Set([own.machineId, thread.machineId, other.machineId]).size).toBe(3)
    expect((await pool.row(thread.machineId))?.scope).toBe('thread:t1')
    // Each box mounts the same folder.
    expect([...machines.boxes.values()].map(box => box.spec.hostWorkspace)).toEqual([dir, dir, dir])
    for (const lease of [own, thread, other]) lease.release()
    await pool.stopScope({ accountId: mia.id, workspace: dir, scope: 'thread:t1' })
    expect((await pool.list()).map(row => row.scope).sort()).toEqual(['', 'thread:t2'])
  })

  it('lets a thread\'s box pause while its agent waits, and resumes it on the next call', async () => {
    const pool = await openPool({ idlePauseMs: 10 })
    const link = await pool.leasedLink({ accountId: mia.id, workspace: dir, scope: 'thread:t1', idleMs: 10 })
    const machineId = (await pool.list())[0]?.id ?? ''
    expect(link.capabilities.platform).toBe('linux')
    let heard = 0
    link.onClose(() => { heard += 1 })
    await expect(link.call('fs/stat', { workspaceId: 'ws_box', path: '/workspace' })).rejects.toThrow('answered')
    // No calls: the lease goes, then the pool pauses the box (and its daemon link closes).
    await expect.poll(async () => (await pool.row(machineId))?.state, { timeout: 2_000 }).toBe('paused')
    expect(link.leased).toBe(false)
    expect(heard).toBe(1)
    const before = linkCalls.length
    await expect(link.call('fs/stat', { workspaceId: 'ws_box', path: '/workspace' })).rejects.toThrow('answered')
    expect((await pool.row(machineId))?.state).toBe('running')
    // The second call ran on the resumed box's new connection, not the closed one.
    const [first, second] = [linkCalls[before - 1]?.split(' ')[0], linkCalls[before]?.split(' ')[0]]
    expect(second).not.toBe(first)
    link.close()
    expect(link.closed).toBe(true)
    await expect(link.call('fs/stat', { workspaceId: 'ws_box', path: '/workspace' })).rejects.toThrow(/closed/)
  })
})

describe('machine pool after a restart', () => {
  it('pauses a box that was running when the server stopped, on the same idle clock', async () => {
    const pool = await openPool({ idlePauseMs: 60_000 })
    const lease = await pool.acquire({ accountId: mia.id, workspace: dir })
    lease.release()
    // The server stops (timers gone) and comes back after the box has been idle long enough.
    pool.dispose()
    await db.query(`update machine set last_used = now() - interval '2 minutes'`)
    // What a new pool does at mount.
    await pool.restore()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await pool.row(lease.machineId))?.state).toBe('paused')
  })
})

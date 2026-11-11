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

function fakeLink(deviceId: string): DaemonLink {
  const listeners = new Set<(reason?: string) => void>()
  let closed = false
  return {
    deviceId,
    protocolVersion: 2,
    capabilities: { fs: true, process: true, http: true, platform: 'linux' },
    workspaces: [{ id: 'ws_box', path: '/workspace' }],
    get closed() { return closed },
    call: () => Promise.reject(new Error('not used')),
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

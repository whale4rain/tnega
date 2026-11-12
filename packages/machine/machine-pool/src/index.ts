import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Service, type Context } from '@tnega/core'
import type { AccountService } from '@tnega/accounts'
import type { DaemonLink } from '@tnega/daemon-protocol'
import type { DaemonRegistry } from '@tnega/daemons'
import { startEgressProxy, type EgressPolicy, type EgressProxy, type KeyPairPem } from '@tnega/egress-proxy'
import { DEFAULT_SETUP_HOSTS, ENVIRONMENT_FILE, egressCredentials, parseEnvironment, type Environment } from '@tnega/environment'
import { MachineError, type BoxIsolation, type BoxNetwork, type BoxResources, type BoxSpec, type MachineService } from '@tnega/machine'
import { millis, optionalText, poolClient, text, type SqlClient, type SqlQueryable } from './sql.js'

export { poolClient, type PgPoolLike, type SqlClient, type SqlQueryable } from './sql.js'

declare module '@tnega/core' {
  interface ServiceMap {
    machinePool: MachinePool
  }
}

/**
 * `ctx.machinePool`: the server's boxes, one per account and workspace. A run
 * that works in a box asks for a lease: the pool finds the box, starts or
 * resumes it through `ctx.machines`, mints the box's daemon token, waits for
 * that daemon in `ctx.daemons`, and hands back its link. When the last lease
 * on a box ends, the box pauses after an idle time; a box paused for long is
 * stopped and its row removed. A host runs at most `maxRunning` boxes: a new
 * one pauses the least recently used idle box first, or is refused.
 *
 * Tokens: every start mints a new daemon device token. A box that resumes
 * from a checkpoint still holds its old one; whichever token connects is
 * kept and the other is revoked, so each box has exactly one live token, and
 * stopping a box revokes it. The egress token works the same way.
 *
 * Rows (`machine`, `machine_session`) live in the server's Postgres, so a
 * restarted server finds its running boxes and their daemons reconnect.
 */

export interface MachinePoolConfig {
  /** `postgresql://…`; the pool opens a small pg pool and closes it with the plugin. */
  url?: string
  /** A client the caller owns (PGlite in tests). Wins over `url`. */
  sql?: SqlClient
  bootstrap?: boolean
  /** Where a box's daemon dials: `wss://…/daemon`, or `ws://<host address>:<port>/daemon` on the same host. */
  serverUrl: string
  /**
   * The daemon may dial `serverUrl` over plain `ws://`. Only for a server
   * reached over the box's own link to this host (gVisor): the traffic never
   * leaves the machine.
   */
  plainServer?: boolean
  template: string
  isolation?: BoxIsolation
  resources?: BoxResources
  /** Default `egress` when `egress` is given, else `none`. */
  network?: 'egress' | 'none' | 'open'
  egress?: PoolEgress
  /** Mount the server's workspace folder in the box (Providers on this host). Default true. */
  hostWorkspace?: boolean
  /** Pause a box this long after its last lease ends. Default 10 minutes. */
  idlePauseMs?: number
  /** Stop and forget a box paused this long. Default 7 days. */
  reclaimAfterMs?: number
  /** Most boxes running on this host at once. Default 3. */
  maxRunning?: number
  /** How long a started box has to connect its daemon. Default 90 s. */
  connectTimeoutMs?: number
  /** How often idle boxes are reclaimed. Default 10 minutes. */
  sweepMs?: number
  /** The workspace's remembered secrets, for the keys the egress proxy adds. */
  rememberedSecrets?: (workspace: string) => Promise<Readonly<Record<string, string>>>
}

export interface PoolEgress {
  /** Where the proxy listens on this host. */
  listen: { host: string; port: number }
  /** The IPv4 address a box reaches the proxy at. */
  advertise: string
  /** The CA boxes trust for the hosts the proxy adds keys to. Keep it across restarts. */
  root: KeyPairPem
  /** Hosts every box may reach. Default: the package registries and GitHub. */
  allow?: readonly string[]
}

export interface MachineLease {
  machineId: string
  /** The device the box's daemon signed in as. */
  deviceId: string
  link: DaemonLink
  /** The workspace's path inside the box. */
  workspacePath: string
  /** End this lease; the box pauses once no lease is left and it has been idle. */
  release(): void
}

export interface MachineRow {
  id: string
  accountId: string
  workspace: string
  provider: string
  ref?: string
  state: 'cold' | 'running' | 'paused'
  specHash: string
  deviceId?: string
  lastUsed: number
}

export type MachinePoolErrorCode = 'POOL_FULL' | 'DAEMON_TIMEOUT'

export class MachinePoolError extends Error {
  override name = 'MachinePoolError'
  constructor(message: string, readonly code: MachinePoolErrorCode) {
    super(message)
  }
}

const WORKSPACE_PATH = '/workspace'

const TABLES = [
  `create table if not exists machine (
    id uuid primary key, account_id uuid not null, workspace text not null,
    provider text not null, ref text,
    state text not null default 'cold' check (state in ('cold','running','paused')),
    spec_hash text not null default '', device_id uuid, egress_hash text,
    created_at timestamptz not null default now(), last_used timestamptz not null default now(),
    unique (account_id, workspace)
  )`,
  `create table if not exists machine_session (
    machine_id uuid not null references machine on delete cascade,
    workspace text not null, session_id text not null,
    last_run timestamptz not null default now(),
    primary key (machine_id, session_id)
  )`,
]

export async function bootstrapMachineTables(sql: SqlClient): Promise<void> {
  await sql.transaction(async tx => {
    await tx.query(`select pg_advisory_xact_lock(7104553552)`)
    for (const statement of TABLES) await tx.query(statement)
  })
}

const COLUMNS = `id::text as id, account_id::text as account_id, workspace, provider, ref, state, spec_hash, device_id::text as device_id, egress_hash, last_used`

function isState(value: string): value is MachineRow['state'] {
  return value === 'cold' || value === 'running' || value === 'paused'
}

type StoredRow = MachineRow & { egressHash?: string }

function rowFrom(row: unknown): StoredRow {
  const state = text(row, 'state')
  if (!isState(state)) throw new TypeError(`machine state ${state}`)
  const ref = optionalText(row, 'ref')
  const deviceId = optionalText(row, 'device_id')
  const egressHash = optionalText(row, 'egress_hash')
  return {
    id: text(row, 'id'),
    accountId: text(row, 'account_id'),
    workspace: text(row, 'workspace'),
    provider: text(row, 'provider'),
    state,
    specHash: text(row, 'spec_hash'),
    lastUsed: millis(row, 'last_used'),
    ...(ref ? { ref } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(egressHash ? { egressHash } : {}),
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class MachinePool extends Service {
  private readonly sql: SqlClient
  private readonly machines: MachineService
  private readonly daemons: DaemonRegistry
  private readonly accounts: AccountService
  private readonly busy = new Map<string, number>()
  private readonly idleTimers = new Map<string, NodeJS.Timeout>()
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Egress policies by the SHA-256 of their token. */
  private readonly policies = new Map<string, EgressPolicy>()
  private room: Promise<unknown> = Promise.resolve()
  proxy: EgressProxy | undefined

  constructor(ctx: Context, private readonly config: MachinePoolConfig, sql: SqlClient) {
    super(ctx, 'machinePool')
    this.sql = sql
    this.machines = ctx.get('machines')
    this.daemons = ctx.get('daemons')
    this.accounts = ctx.get('accounts')
  }

  private get network(): 'egress' | 'none' | 'open' {
    return this.config.network ?? (this.config.egress ? 'egress' : 'none')
  }

  /** Hash of what a box is built from; a change starts the box again instead of resuming it. */
  private specHash(workspace: string): string {
    return sha256(JSON.stringify({
      template: this.config.template,
      isolation: this.config.isolation ?? 'gvisor',
      network: this.network,
      proxy: this.config.egress?.advertise ?? '',
      server: this.config.serverUrl,
      host: this.config.hostWorkspace === false ? '' : workspace,
    })).slice(0, 32)
  }

  /** The egress policy for a box token, read by the proxy on every connection. */
  egressPolicy(token: string): EgressPolicy | undefined {
    return this.policies.get(sha256(token))
  }

  private async environment(workspace: string): Promise<Environment | undefined> {
    if (this.config.hostWorkspace === false) return undefined
    const raw = await readFile(join(workspace, ENVIRONMENT_FILE), 'utf8').catch(() => undefined)
    return raw === undefined ? undefined : parseEnvironment(raw)
  }

  private async policyFor(row: Pick<MachineRow, 'id' | 'workspace'>): Promise<EgressPolicy> {
    const environment = await this.environment(row.workspace).catch(() => undefined)
    const allow = [...new Set([...(this.config.egress?.allow ?? DEFAULT_SETUP_HOSTS), ...environment?.network.allow ?? []])]
    let credentials: EgressPolicy['credentials'] = []
    if (environment?.network.credentials.length && this.config.rememberedSecrets) {
      const secrets = await this.config.rememberedSecrets(row.workspace)
      credentials = egressCredentials(environment, Object.entries(secrets).map(([name, value]) => ({ name, value }))).credentials
    }
    return { name: `box ${row.id.slice(0, 8)}`, allow, credentials }
  }

  /** Load the policies of boxes that may still run, and note boxes that stopped while the server was away. */
  async restore(): Promise<void> {
    const { rows } = await this.sql.query(`select ${COLUMNS} from machine where state <> 'cold'`)
    for (const raw of rows) {
      const row = rowFrom(raw)
      if (row.egressHash) this.policies.set(row.egressHash, await this.policyFor(row))
      if (row.state === 'running' && row.ref && await this.machines.status(row.ref) !== 'running') {
        await this.setState(row.id, 'cold')
      } else if (row.state === 'running' && !this.busy.get(row.id)) {
        // A box that ran when the server stopped pauses on the same clock as before.
        this.pauseWhenIdle(row.id, row.lastUsed + this.idleMs - Date.now())
      }
    }
  }

  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    this.locks.set(id, run)
    try {
      return await run
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id)
    }
  }

  private async setState(id: string, state: MachineRow['state'], tx: SqlQueryable = this.sql): Promise<void> {
    await tx.query(`update machine set state = $2 where id = $1::uuid`, [id, state])
  }

  async row(id: string): Promise<StoredRow | undefined> {
    const { rows } = await this.sql.query(`select ${COLUMNS} from machine where id = $1::uuid`, [id])
    return rows[0] === undefined ? undefined : rowFrom(rows[0])
  }

  async list(): Promise<MachineRow[]> {
    const { rows } = await this.sql.query(`select ${COLUMNS} from machine order by last_used desc`)
    return rows.map(rowFrom)
  }

  /** The box for an account's workspace, running and connected, with a lease on it. */
  async acquire(input: { accountId: string; workspace: string; sessionId?: string; signal?: AbortSignal }): Promise<MachineLease> {
    const { rows } = await this.sql.query(
      `insert into machine (id, account_id, workspace, provider) values ($1::uuid, $2::uuid, $3, $4)
       on conflict (account_id, workspace) do update set provider = excluded.provider
       returning ${COLUMNS}`,
      [randomUUID(), input.accountId, input.workspace, this.machines.kind],
    )
    const id = rowFrom(rows[0]).id
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1)
    const timer = this.idleTimers.get(id)
    if (timer) clearTimeout(timer)
    this.idleTimers.delete(id)
    try {
      const { deviceId, link } = await this.locked(id, () => this.ensureRunning(id, input.signal))
      await this.sql.query(`update machine set last_used = now() where id = $1::uuid`, [id])
      if (input.sessionId) {
        await this.sql.query(
          `insert into machine_session (machine_id, workspace, session_id) values ($1::uuid, $2, $3)
           on conflict (machine_id, session_id) do update set last_run = now()`,
          [id, input.workspace, input.sessionId],
        )
      }
      let released = false
      return {
        machineId: id,
        deviceId,
        link,
        workspacePath: WORKSPACE_PATH,
        release: () => {
          if (released) return
          released = true
          this.leave(id)
        },
      }
    } catch (error) {
      this.leave(id)
      throw error
    }
  }

  private leave(id: string): void {
    const left = Math.max(0, (this.busy.get(id) ?? 1) - 1)
    if (left) {
      this.busy.set(id, left)
      return
    }
    this.busy.delete(id)
    void this.sql.query(`update machine set last_used = now() where id = $1::uuid`, [id]).catch(() => undefined)
    this.pauseWhenIdle(id, this.idleMs)
  }

  private get idleMs(): number {
    return this.config.idlePauseMs ?? 10 * 60_000
  }

  /** Pause the box after `delayMs` unless a lease comes first. */
  private pauseWhenIdle(id: string, delayMs: number): void {
    const previous = this.idleTimers.get(id)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.idleTimers.delete(id)
      if (!this.busy.get(id)) void this.pause(id).catch(() => undefined)
    }, Math.max(0, delayMs))
    timer.unref()
    this.idleTimers.set(id, timer)
  }

  private async ensureRunning(id: string, signal?: AbortSignal): Promise<{ deviceId: string; link: DaemonLink }> {
    const row = await this.row(id)
    if (!row) throw new MachineError(`machine ${id} is gone`, 'MACHINE_FAILED')
    const live = row.deviceId ? this.daemons.get(row.deviceId) : undefined
    if (row.state === 'running' && live) return { deviceId: live.deviceId, link: live.link }
    // Making room and claiming it are one step, so two starts never both take the last place.
    const claim = this.room.catch(() => undefined).then(() => this.makeRoom(id))
    this.room = claim
    await claim
    const minted = await this.accounts.createDevice(row.accountId, { kind: 'daemon', name: `box ${id.slice(0, 8)}` }, row.accountId)
    const egressToken = randomBytes(32).toString('base64url')
    const egressHash = sha256(egressToken)
    if (this.network === 'egress') this.policies.set(egressHash, await this.policyFor(row))
    const network = this.boxNetwork(egressToken)
    const specHash = this.specHash(row.workspace)
    const spec: BoxSpec = {
      template: this.config.template,
      daemon: { serverUrl: this.config.serverUrl, token: minted.token },
      workspacePath: WORKSPACE_PATH,
      ...(this.config.hostWorkspace === false ? {} : { hostWorkspace: row.workspace }),
      ...(this.config.plainServer ? { env: { TNEGA_DAEMON_ALLOW_WS: '1' } } : {}),
      ...(this.config.resources ? { resources: this.config.resources } : {}),
      network,
      isolation: this.config.isolation ?? 'gvisor',
      labels: { 'dev.tnega.machine': id, 'dev.tnega.account': row.accountId },
      specHash,
    }
    const forget = async (): Promise<void> => {
      await this.accounts.revokeDevice(row.accountId, minted.principal.device.id).catch(() => false)
      this.policies.delete(egressHash)
    }
    let ref: string
    try {
      ref = (await this.machines.start(id, spec)).ref
    } catch (error) {
      if (!(error instanceof MachineError && error.code === 'MACHINE_SPEC_CHANGED' && error.ref)) {
        await forget()
        throw error
      }
      // Built from an older spec. The work is in the workspace on this host (or the
      // box's own volume, which a Provider keeps across a stop only if it can), so
      // stop the old box and start a new one.
      await this.machines.stop(error.ref)
      ref = (await this.machines.start(id, spec)).ref
    }
    await this.sql.query(`update machine set ref = $2, state = 'running', spec_hash = $3 where id = $1::uuid`, [id, ref, specHash])
    // A box resumed from a checkpoint dials with its old token; a new one with the new token.
    const candidates = [minted.principal.device.id, ...(row.deviceId ? [row.deviceId] : [])]
    const timeoutMs = this.config.connectTimeoutMs ?? 90_000
    let connected
    try {
      connected = await Promise.any(candidates.map(deviceId => this.daemons.wait(deviceId, timeoutMs, signal)))
    } catch {
      await this.machines.stop(ref).catch(() => undefined)
      await this.setState(id, 'cold')
      await forget()
      throw new MachinePoolError(`box ${id.slice(0, 8)} started but its daemon did not connect within ${Math.round(timeoutMs / 1000)} s`, 'DAEMON_TIMEOUT')
    }
    const resumed = connected.deviceId !== minted.principal.device.id
    if (resumed) {
      await forget()
    } else {
      if (row.deviceId) {
        await this.accounts.revokeDevice(row.accountId, row.deviceId).catch(() => false)
        this.daemons.disconnect(row.deviceId, 'replaced by a new box')
      }
      if (row.egressHash) this.policies.delete(row.egressHash)
      await this.sql.query(`update machine set device_id = $2::uuid, egress_hash = $3 where id = $1::uuid`, [id, connected.deviceId, this.network === 'egress' ? egressHash : null])
    }
    return { deviceId: connected.deviceId, link: connected.link }
  }

  private boxNetwork(token: string): BoxNetwork {
    const network = this.network
    if (network === 'open') return { mode: 'open' }
    if (network === 'none') return { mode: 'none' }
    const egress = this.config.egress
    if (!egress || !this.proxy) throw new MachineError('egress boxes need the egress proxy', 'SANDBOX_UNAVAILABLE')
    const port = 'port' in this.proxy.address ? this.proxy.address.port : egress.listen.port
    return {
      mode: 'egress',
      egress: {
        proxyUrl: `http://${egress.advertise}:${port}`,
        proxyAddresses: [egress.advertise],
        token,
        caCertificate: this.proxy.caCertificate,
      },
    }
  }

  /** Below the cap, or pause the least recently used idle box; refuse when every running box is busy. */
  private async makeRoom(forId: string): Promise<void> {
    const max = this.config.maxRunning ?? 3
    const { rows } = await this.sql.query(`select ${COLUMNS} from machine where state = 'running' and id <> $1::uuid order by last_used asc`, [forId])
    const running = rows.map(rowFrom)
    if (running.length < max) return
    const idle = running.filter(row => !this.busy.get(row.id))
    const excess = running.length - max + 1
    if (idle.length < excess) {
      throw new MachinePoolError(`this host already runs ${running.length} boxes, all of them busy; try again when one is free`, 'POOL_FULL')
    }
    for (const row of idle.slice(0, excess)) await this.pause(row.id)
  }

  /** Pause a box: memory and processes kept where the Provider can, its daemon's token kept for the resume. */
  async pause(id: string): Promise<void> {
    await this.locked(id, async () => {
      const row = await this.row(id)
      if (!row || row.state !== 'running' || !row.ref) return
      if (this.busy.get(id)) return
      await this.machines.pause(row.ref)
      await this.setState(id, 'paused')
    })
  }

  /** Stop a box for good: workspace volume gone (a host folder stays), token revoked, row removed. */
  async stop(id: string): Promise<void> {
    await this.locked(id, async () => {
      const row = await this.row(id)
      if (!row) return
      if (row.ref) await this.machines.stop(row.ref)
      if (row.deviceId) {
        await this.accounts.revokeDevice(row.accountId, row.deviceId).catch(() => false)
        this.daemons.disconnect(row.deviceId, 'box stopped')
      }
      const { rows } = await this.sql.query(`delete from machine where id = $1::uuid returning egress_hash`, [id])
      const hash = rows[0] === undefined ? undefined : optionalText(rows[0], 'egress_hash')
      if (hash) this.policies.delete(hash)
    })
  }

  /** Stop boxes nobody used for `reclaimAfterMs`. Returns how many went. */
  async reclaim(now = Date.now()): Promise<number> {
    const before = new Date(now - (this.config.reclaimAfterMs ?? 7 * 24 * 3_600_000)).toISOString()
    const { rows } = await this.sql.query(`select ${COLUMNS} from machine where last_used < $1::timestamptz`, [before])
    let stopped = 0
    for (const row of rows.map(rowFrom)) {
      if (this.busy.get(row.id)) continue
      await this.stop(row.id)
      stopped++
    }
    return stopped
  }

  /** Timers only; boxes keep running so their daemons reconnect to the next server. */
  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
  }
}

export const machinePool = {
  name: 'machine-pool',
  inject: ['machines', 'daemons', 'accounts'],
  async apply(ctx: Context, config: MachinePoolConfig): Promise<void> {
    const pgPool = config.sql ? undefined : new pg.Pool({ connectionString: config.url, max: 4 })
    const sql = config.sql ?? (pgPool ? poolClient(pgPool) : undefined)
    if (!sql) throw new TypeError('machine-pool needs a url or a sql client')
    if (pgPool) ctx.fiber.effect(() => () => pgPool.end(), 'machine-pool/pg')
    if (config.bootstrap !== false) await bootstrapMachineTables(sql)
    const pool = new MachinePool(ctx, config, sql)
    if (config.egress && (config.network ?? 'egress') === 'egress') {
      pool.proxy = await startEgressProxy(config.egress.listen, { root: config.egress.root, policy: token => pool.egressPolicy(token) })
      const proxy = pool.proxy
      ctx.fiber.effect(() => () => proxy.close(), 'machine-pool/egress')
    }
    await pool.restore()
    const sweep = setInterval(() => { void pool.reclaim().catch(() => undefined) }, config.sweepMs ?? 10 * 60_000)
    sweep.unref()
    ctx.fiber.effect(() => () => { clearInterval(sweep); pool.dispose() }, 'machine-pool/timers')
  },
}

export const name = '@tnega/machine-pool'

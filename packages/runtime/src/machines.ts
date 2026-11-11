import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Context, Plugin } from '@tnega/core'
import { daemonGateway } from '@tnega/daemon-gateway'
import { daemons } from '@tnega/daemons'
import { createRootCertificate, type KeyPairPem } from '@tnega/egress-proxy'
import { machineE2B, type E2BMachineConfig } from '@tnega/machine-e2b'
import { machineGvisor, type GvisorMachineConfig } from '@tnega/machine-gvisor'
import { machinePool, type MachineLease, type MachinePoolConfig } from '@tnega/machine-pool'
import type { MachineSpec } from './compose.js'

/**
 * Boxes on a server (v2 milestone 3): where each person's runs work. The
 * composition picks the Provider of `ctx.machines` from the host's setting,
 * opens the daemon door (`ctx.daemons` plus the `/daemon` gateway) and the
 * pool that starts, pauses and reclaims boxes. Off unless the host turned it
 * on: nothing here falls back from one Provider to another.
 */
export type MachineProviderSpec =
  | { kind: 'gvisor'; config?: GvisorMachineConfig }
  | { kind: 'e2b'; config: E2BMachineConfig }

export interface MachinesCapabilitySpec {
  provider: MachineProviderSpec
  /** The server's database, for the pool's rows. */
  databaseUrl: string
  pool: Omit<MachinePoolConfig, 'url' | 'sql'>
  /** A listener of the gateway's own on the box-facing address (gVisor). */
  gatewayListen?: { host: string; port: number }
}

/**
 * The server's daemon door: `ctx.daemons` and the `/daemon` WebSocket that
 * `tnega daemon --server` and boxes dial with a daemon token. Every server
 * with sign-in has it; `listen` adds the box-facing listener.
 */
export const daemonDoorCapability: Plugin = {
  name: 'capability:daemon-door',
  inject: ['accounts', 'webServer'],
  async apply(ctx: Context, spec: { listen?: { host: string; port: number } } = {}) {
    await ctx.plugin(daemons)
    await ctx.plugin(daemonGateway, spec.listen ? { listen: spec.listen } : {})
  },
}

/** Boxes on the door: the Provider the host picked and the pool. Mount {@link daemonDoorCapability} first. */
export const machinesCapability: Plugin = {
  name: 'capability:machines',
  inject: ['accounts', 'daemons'],
  async apply(ctx: Context, spec: MachinesCapabilitySpec) {
    if (spec.provider.kind === 'gvisor') await ctx.plugin(machineGvisor, spec.provider.config ?? {})
    else await ctx.plugin(machineE2B, spec.provider.config)
    await ctx.plugin(machinePool, { ...spec.pool, url: spec.databaseUrl })
  },
}

/** The `MachineSpec` a run in a box gets: its daemon's link, and no secret values in the box. */
export function boxMachine(lease: MachineLease, hostWorkspace: string): MachineSpec {
  return { link: lease.link, secrets: { withholdOthers: true }, hostWorkspace }
}

/** This host's first private IPv4 address: where its boxes reach it. */
export function hostPrivateAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('10.88.')) return entry.address
    }
  }
  return undefined
}

/** The egress CA, kept in the server folder so boxes and restarts agree on it. */
export async function loadEgressRoot(dir: string): Promise<KeyPairPem> {
  const file = join(dir, 'egress-ca.json')
  const saved = await readFile(file, 'utf8').then(text => {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && 'certificatePem' in value && 'keyPem' in value
      && typeof value.certificatePem === 'string' && typeof value.keyPem === 'string') {
      return { certificatePem: value.certificatePem, keyPem: value.keyPem }
    }
    throw new Error(`${file} is not an egress CA`)
  }, (error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (saved) return saved
  const root = createRootCertificate()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify(root), { mode: 0o600, flag: 'wx' })
  return root
}

export interface MachinesEnvContext {
  /** The server folder: the egress CA is kept there. */
  dir: string
  databaseUrl: string
  publicUrl?: string
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

/**
 * The boxes a server's environment asks for, or undefined when they are off.
 *
 * - `TNEGA_MACHINE`: `gvisor`, `e2b` or `off` (default). Anything else is refused.
 * - `TNEGA_BOX_TEMPLATE`: the template (default `tnega-box`).
 * - `TNEGA_BOX_NETWORK`: `egress` (default), `none` or `open`.
 * - `TNEGA_BOX_ADDRESS`: the IPv4 address boxes reach this host at (gVisor; default the first private one).
 * - `TNEGA_BOX_SERVER_URL`: where a box's daemon dials; for gVisor default `ws://<box address>:<TNEGA_BOX_DAEMON_PORT>/daemon`,
 *   for E2B the `wss://` form of `TNEGA_PUBLIC_URL`.
 * - `TNEGA_BOX_DAEMON_PORT` (default 7779) and `TNEGA_EGRESS_PORT` (default 7778) on the box address.
 * - `TNEGA_BOX_MAX` (default 3), `TNEGA_BOX_IDLE_MINUTES` (default 10), `TNEGA_BOX_RECLAIM_DAYS` (default 7).
 * - E2B: `E2B_API_KEY`, `E2B_API_URL` (default `https://api.e2b.app`).
 */
export async function machinesSpecFromEnv(env: NodeJS.ProcessEnv, host: MachinesEnvContext): Promise<MachinesCapabilitySpec | undefined> {
  const kind = env.TNEGA_MACHINE?.trim().toLowerCase() || 'off'
  if (kind === 'off') return undefined
  if (kind !== 'gvisor' && kind !== 'e2b') throw new Error(`unknown TNEGA_MACHINE: ${env.TNEGA_MACHINE}; use gvisor, e2b or off`)
  const network = env.TNEGA_BOX_NETWORK?.trim() || 'egress'
  if (network !== 'egress' && network !== 'none' && network !== 'open') throw new Error('TNEGA_BOX_NETWORK must be egress, none or open')
  const address = env.TNEGA_BOX_ADDRESS?.trim() || hostPrivateAddress()
  if (!address) throw new Error('no private IPv4 address for boxes to reach this host; set TNEGA_BOX_ADDRESS')
  const egressPort = positive(env, 'TNEGA_EGRESS_PORT', 7778)
  const daemonPort = positive(env, 'TNEGA_BOX_DAEMON_PORT', 7779)
  const pool = {
    template: env.TNEGA_BOX_TEMPLATE?.trim() || 'tnega-box',
    network,
    maxRunning: positive(env, 'TNEGA_BOX_MAX', 3),
    idlePauseMs: positive(env, 'TNEGA_BOX_IDLE_MINUTES', 10) * 60_000,
    reclaimAfterMs: positive(env, 'TNEGA_BOX_RECLAIM_DAYS', 7) * 24 * 3_600_000,
    ...(network === 'egress'
      ? { egress: { listen: { host: address, port: egressPort }, advertise: address, root: await loadEgressRoot(host.dir) } }
      : {}),
  } satisfies Partial<MachinePoolConfig>
  if (kind === 'gvisor') {
    const serverUrl = env.TNEGA_BOX_SERVER_URL?.trim() || `ws://${address}:${daemonPort}/daemon`
    return {
      provider: { kind: 'gvisor' },
      databaseUrl: host.databaseUrl,
      // The box reaches the gateway over its own link to this host, never past it.
      pool: { ...pool, serverUrl, plainServer: serverUrl.startsWith('ws://'), hostWorkspace: true, isolation: 'gvisor' },
      gatewayListen: { host: address, port: daemonPort },
    }
  }
  const apiKey = env.E2B_API_KEY?.trim()
  if (!apiKey) throw new Error('TNEGA_MACHINE=e2b needs E2B_API_KEY')
  const publicUrl = env.TNEGA_BOX_SERVER_URL?.trim() || (host.publicUrl?.startsWith('https://') ? `wss://${new URL(host.publicUrl).host}/daemon` : undefined)
  if (!publicUrl?.startsWith('wss://')) throw new Error('TNEGA_MACHINE=e2b needs the server on https (TNEGA_PUBLIC_URL) or TNEGA_BOX_SERVER_URL=wss://…')
  return {
    provider: { kind: 'e2b', config: { apiUrl: env.E2B_API_URL?.trim() || 'https://api.e2b.app', apiKey } },
    databaseUrl: host.databaseUrl,
    // An E2B box cannot mount this host's folder: its workspace is its own volume.
    pool: { ...pool, serverUrl: publicUrl, hostWorkspace: false, isolation: 'microvm' },
  }
}

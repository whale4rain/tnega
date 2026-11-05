import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    machines: MachineService
  }
}

/**
 * The machine seam (`ctx.machines`): start and stop **boxes**, the containers
 * or VMs a `tnega daemon` runs in when the agent's workspace is not on a
 * person's own computer. In code a box is a machine because `ctx.box` already
 * names the Project message channel.
 *
 * The Definition says what a box is and what every Provider must guarantee;
 * how a box is made (an E2B microVM, a hosted sandbox …) is the Provider's.
 * See docs/adr/0018-microvm-box-layer.md.
 * The composition layer picks the Provider; nothing else may name one.
 */

/** What a box is built from and how it reaches the runtime. */
export interface BoxSpec {
  /** The template the box starts from: the tnega box image with `tnega daemon` in it. */
  template: string
  /** The daemon inside the box dials this runtime with this one-time token. Mint a new one for every new box. */
  daemon: { serverUrl: string; token: string }
  /** Where the workspace lives inside the box; it outlives the box (sleep, wake). */
  workspacePath: string
  /**
   * Plain environment for everything in the box. Never secrets: an approved
   * secret reaches only the setup step, through that one command's environment.
   */
  env?: Readonly<Record<string, string>>
  resources?: BoxResources
  network: BoxNetwork
  /**
   * How strongly the box is kept apart from its host. A Provider that cannot
   * give this level refuses the start with `SANDBOX_UNAVAILABLE`; it never
   * gives a weaker one. Defaults to `container`.
   */
  isolation?: BoxIsolation
  /** Labels the Provider keeps on the box, for a person reading the host. */
  labels?: Readonly<Record<string, string>>
  /**
   * Hash of the environment the box is built from (template, setup, network).
   * The Provider keeps it on the box; a start whose hash differs from the
   * box's refuses with `MACHINE_SPEC_CHANGED` instead of reusing it, so setup
   * secrets from an old spec never carry over in a paused box.
   */
  specHash?: string
}

/**
 * `container`: a hardened container (non-root, no capabilities, seccomp).
 * `gvisor`: the same behind a user-space kernel. `microvm`: its own kernel.
 */
export type BoxIsolation = 'container' | 'gvisor' | 'microvm'

export const BOX_ISOLATION_LEVELS: readonly BoxIsolation[] = ['container', 'gvisor', 'microvm']

export interface BoxResources {
  cpus?: number
  memoryMb?: number
  /** Most processes the box may run at once. */
  pids?: number
}

/**
 * The box's network. `egress`: the egress proxy is the box's only route out
 * (it decides hosts and adds keys per client token); a Provider that cannot
 * enforce that fails the start with `SANDBOX_UNAVAILABLE` and never falls back
 * to an open network. `open` is the explicit opt-out, like `bypass` for the
 * sandbox. `none`: no network at all, except the daemon's own connection.
 */
export type BoxNetwork =
  | { mode: 'egress'; egress: BoxEgress }
  | { mode: 'open' }
  | { mode: 'none' }

/** How a box reaches the egress proxy: its address, the box's client credential, and the CA it must trust. */
export interface BoxEgress {
  /** `http://host:port` as seen from inside the box. */
  proxyUrl: string
  /** The proxy's IP address(es) as the box's firewall sees them; the only allowed destinations. */
  proxyAddresses: readonly string[]
  /** Sent as `Proxy-Authorization: Basic base64(box:<token>)`; names the box's policy. */
  token: string
  /** PEM of the proxy's CA, for hosts the proxy adds credentials to. */
  caCertificate: string
}

export type MachineState = 'running' | 'paused' | 'exited' | 'missing'

export interface MachineRef {
  /** The Provider's handle for the box (a container id, a VM id …). */
  ref: string
}

/**
 * What each Provider implements.
 *
 * - `start(key, spec)` is safe to repeat: the key is the caller's stable id for
 *   the box (the server's `machine` row), and a second start with the same key
 *   returns the same box, resumed if it was paused, instead of a new one.
 *   When that box was built from another `specHash`, start refuses with
 *   `MACHINE_SPEC_CHANGED` and the old ref: the caller resumes it with its old
 *   spec, saves the work, stops it, and starts again.
 * - `pause(ref)` keeps memory and disk; the next `start` with the same key
 *   resumes it. `stop(ref)` kills the box and releases it, workspace included.
 *   Both succeed on a box that is already gone.
 * - `status(ref)` never throws for a box that is gone: it answers `missing`.
 */
export interface MachineProvider {
  /** Short name of the mechanism (`docker`, `e2b`, …), for logs and settings. */
  readonly kind: string
  start(key: string, spec: BoxSpec): Promise<MachineRef>
  pause(ref: string): Promise<void>
  stop(ref: string): Promise<void>
  status(ref: string): Promise<MachineState>
}

export type MachineErrorCode =
  /** The Provider cannot enforce the box's network policy; nothing was started. */
  | 'SANDBOX_UNAVAILABLE'
  /** The mechanism itself is not reachable (no API, a wrong API key …). */
  | 'MACHINE_UNAVAILABLE'
  /** The spec cannot be honoured (unknown image, bad resources …). */
  | 'MACHINE_INVALID'
  /** The key's box was built from another spec; `ref` names it. Nothing was started. */
  | 'MACHINE_SPEC_CHANGED'
  | 'MACHINE_FAILED'

export class MachineError extends Error {
  override name = 'MachineError'
  /** The existing box, for `MACHINE_SPEC_CHANGED`. */
  readonly ref: string | undefined

  constructor(message: string, readonly code: MachineErrorCode, options?: { cause?: unknown; ref?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.ref = options?.ref
  }
}

/** The Service Definition of `ctx.machines`; one Provider per scope. */
export abstract class MachineService extends Service implements MachineProvider {
  abstract readonly kind: string

  constructor(ctx: Context) {
    super(ctx, 'machines')
  }

  abstract start(key: string, spec: BoxSpec): Promise<MachineRef>
  abstract pause(ref: string): Promise<void>
  abstract stop(ref: string): Promise<void>
  abstract status(ref: string): Promise<MachineState>
}

/** Check a spec before any Provider acts on it, so every Provider refuses the same things. */
export function validateBoxSpec(spec: BoxSpec): void {
  const fail = (message: string): never => { throw new MachineError(message, 'MACHINE_INVALID') }
  if (!spec.template.trim()) fail('the box needs a template')
  if (!/^(?:wss|ws):\/\//u.test(spec.daemon.serverUrl)) fail('daemon.serverUrl must be a ws:// or wss:// URL')
  if (!spec.daemon.token) fail('the box needs a daemon token')
  if (!spec.workspacePath.startsWith('/')) fail('workspacePath must be an absolute path inside the box')
  for (const name of Object.keys(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) fail(`env name ${name} is not a valid variable name`)
  }
  if (spec.network.mode === 'egress') {
    const { egress } = spec.network
    if (!/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d+$/u.test(egress.proxyUrl.replace(/\/$/u, ''))) fail('egress.proxyUrl must be http://<IPv4>:port: the box has no DNS of its own')
    if (!egress.proxyAddresses.length) fail('egress.proxyAddresses must name the proxy, the only allowed destination')
    for (const address of egress.proxyAddresses) {
      if (!/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/u.test(address)) fail(`egress.proxyAddresses must be IPv4 addresses or CIDRs, not ${address}: a name would open DNS past the proxy`)
    }
    if (!egress.token) fail('the box needs an egress token')
    if (!egress.caCertificate.includes('BEGIN CERTIFICATE')) fail('egress.caCertificate must be a PEM certificate')
  }
  if (spec.isolation !== undefined && !BOX_ISOLATION_LEVELS.includes(spec.isolation)) fail(`isolation must be one of ${BOX_ISOLATION_LEVELS.join(', ')}`)
  const { cpus, memoryMb, pids } = spec.resources ?? {}
  if (pids !== undefined && !(Number.isInteger(pids) && pids >= 16)) fail('resources.pids must be a whole number of at least 16')
  if (cpus !== undefined && !(cpus > 0)) fail('resources.cpus must be positive')
  if (memoryMb !== undefined && !(Number.isInteger(memoryMb) && memoryMb >= 128)) fail('resources.memoryMb must be a whole number of at least 128')
}

/** `Proxy-Authorization` value for a box's egress token. */
export function egressAuthorization(token: string): string {
  return `Basic ${Buffer.from(`box:${token}`, 'utf8').toString('base64')}`
}

/** The proxy URL with the box credential in it, for `HTTPS_PROXY` inside the box. */
export function egressProxyUrl(egress: BoxEgress): string {
  const url = new URL(egress.proxyUrl)
  url.username = 'box'
  url.password = egress.token
  return url.href.replace(/\/$/u, '')
}

/**
 * The environment every Provider gives the box, so the template's start script
 * is the same everywhere: where the daemon dials, the workspace, and the
 * proxy the box's tools must use. The start script moves the daemon token and
 * the CA out of the environment before the daemon runs any command.
 */
export function boxEnvironment(spec: BoxSpec): Record<string, string> {
  const env: Record<string, string> = {
    ...spec.env,
    TNEGA_SERVER: spec.daemon.serverUrl,
    TNEGA_DAEMON_TOKEN: spec.daemon.token,
    TNEGA_WORKSPACE: spec.workspacePath,
  }
  if (spec.network.mode === 'egress') {
    const proxy = egressProxyUrl(spec.network.egress)
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) env[name] = proxy
    env.NO_PROXY = ''
    env.no_proxy = ''
    env.TNEGA_EGRESS_CA = spec.network.egress.caCertificate
  }
  return env
}

export const name = '@tnega/machine'

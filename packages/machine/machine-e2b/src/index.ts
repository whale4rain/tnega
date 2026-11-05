import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import type { Context } from '@tnega/core'
import { defaultBuildLogger, Sandbox, Template, type BuildInfo } from 'e2b'
import {
  boxEnvironment,
  MachineError,
  MachineService,
  validateBoxSpec,
  type BoxSpec,
  type MachineRef,
  type MachineState,
} from '@tnega/machine'

/**
 * `@tnega/machine-e2b`: boxes as Firecracker microVMs on E2B's runtime, the
 * open-source one a person hosts themselves or E2B's cloud, by API URL
 * (docs/adr/0018-microvm-box-layer.md). It speaks E2B's REST API directly.
 *
 * - The machine key and spec hash are kept in the sandbox's metadata, so a
 *   repeated start finds the same sandbox and resumes it if it was paused; a
 *   create carries an `Idempotency-Key` made from the key and the box's
 *   one-time daemon token, so two racing or retried starts of one box make
 *   one sandbox, while the next box for the same key (a new token) is a new
 *   create rather than a replay of a deleted one (E2B keeps keys for a day).
 *   Callers therefore mint a new daemon token for every new box. Starts for
 *   one key in this process run one after another, so a second start finds
 *   the first one's box; across processes the server's effect queue runs one
 *   `machine.start` per machine at a time. A box from another spec hash is
 *   refused, not reused.
 * - Pause keeps memory and disk; the box's shell, dev servers and jobs are
 *   still running when it resumes. A sandbox that times out pauses rather than
 *   dies, so nothing is lost when the server forgets to pause it.
 * - Network: with `egress`, the sandbox's firewall denies everything except
 *   the egress proxy and the server the daemon dials. E2B enforces it outside
 *   the VM, so a command inside cannot route around it. Only IP addresses go
 *   in the firewall, never names: E2B opens DNS to 8.8.8.8 as soon as one
 *   name is allowed, and DNS queries could carry data out past the proxy. The
 *   server's name is resolved here and written to the box's `/etc/hosts`
 *   (`TNEGA_HOSTS`, read by the template's start script); everything else is
 *   resolved by the egress proxy.
 * - The daemon starts after the box does, not as the template's start
 *   command: E2B runs that command once, when the template is built, and
 *   every box resumes from that snapshot, so it would never see a box's own
 *   token. Each start runs the template's start script through E2B's command
 *   API (as root, with the box's daemon and proxy settings in that one
 *   command's environment), unless the daemon is running already. The box's
 *   own environment stays empty, so the agent's commands do not inherit the
 *   daemon token.
 * - CPU and memory come from the template on E2B; `BoxSpec.resources` cannot
 *   change them per box and are not sent.
 */

export interface E2BMachineConfig {
  /** `https://api.e2b.app`, or the self-hosted runtime's API URL. */
  apiUrl: string
  apiKey: string
  /**
   * Seconds a box lives without a call before E2B pauses it on its own; the
   * server pauses it sooner (§4.7). Default one hour.
   */
  timeoutSeconds?: number
  /** Milliseconds one API call may take. Default 60 seconds. */
  requestTimeoutMs?: number
  /** Replace `fetch` (tests). */
  fetch?: typeof globalThis.fetch
  /** Replace DNS for the server's name (tests). Default: the system resolver. */
  resolve?: (host: string) => Promise<string[]>
  /** Replace how the daemon is started in a box (tests). Default: E2B's command API. */
  launch?: DaemonLauncher
}

/** Start the daemon in a running box, with these variables in its environment; nothing when it runs already. */
export type DaemonLauncher = (ref: string, env: Readonly<Record<string, string>>) => Promise<void>

/** Where the template puts its start script (deploy/e2b/template). */
export const BOX_START_SCRIPT = '/usr/local/bin/tnega-box-start'
/**
 * Start the daemon unless it runs. `[t]nega` keeps the pattern from matching
 * this shell's own command line; `setsid -f` detaches the daemon, so it
 * outlives the command that started it.
 */
export const LAUNCH_COMMAND = `pgrep -f '[t]nega daemon --server' >/dev/null || setsid -f ${BOX_START_SCRIPT} >>/var/log/tnega-daemon.log 2>&1 </dev/null`

/** E2B's domain for an API URL: `https://api.e2b.app` serves boxes at `*.e2b.app`. */
export function e2bDomain(apiUrl: string): string {
  const host = new URL(apiUrl).host
  return host.startsWith('api.') ? host.slice(4) : host
}

/** The default launcher: E2B's command API, through its SDK. */
export function e2bLauncher(config: Pick<E2BMachineConfig, 'apiUrl' | 'apiKey' | 'requestTimeoutMs'>): DaemonLauncher {
  return async (ref, env) => {
    try {
      const box = await Sandbox.connect(ref, { apiKey: config.apiKey, apiUrl: config.apiUrl, domain: e2bDomain(config.apiUrl), requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS })
      await box.commands.run(LAUNCH_COMMAND, { user: 'root', envs: { ...env }, timeoutMs: 60_000 })
    } catch (error) {
      throw new MachineError(`could not start the daemon in box ${ref}: ${error instanceof Error ? error.message : String(error)}`, 'MACHINE_FAILED', { ref, cause: error })
    }
  }
}

/** Metadata key holding the machine key on each sandbox. */
export const MACHINE_KEY_METADATA = 'tnega_machine'
/** Metadata key holding the box's spec hash. */
export const SPEC_HASH_METADATA = 'tnega_spec_hash'

interface ListedSandbox {
  sandboxID: string
  state: 'running' | 'paused'
  key: string | undefined
  specHash: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one sandbox from a list answer; anything unexpected is skipped. */
function listedSandbox(value: unknown): ListedSandbox | undefined {
  if (!isRecord(value) || typeof value.sandboxID !== 'string') return undefined
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const text = (name: string): string | undefined => {
    const field = metadata[name]
    return typeof field === 'string' ? field : undefined
  }
  return { sandboxID: value.sandboxID, state: value.state === 'paused' ? 'paused' : 'running', key: text(MACHINE_KEY_METADATA), specHash: text(SPEC_HASH_METADATA) }
}

const DEFAULT_TIMEOUT_SECONDS = 3_600
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** One create attempt: stable across retries of the same box, new for the next box (lowercase hex, as E2B accepts). */
function createAttempt(key: string, spec: BoxSpec): string {
  return createHash('sha256').update(`${key}\n${spec.daemon.token}`).digest('hex')
}

async function systemResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, family: 4 })).map(entry => entry.address)
}

export class E2BMachines extends MachineService {
  readonly kind = 'e2b'
  private readonly apiUrl: string
  private readonly fetch: typeof globalThis.fetch
  /** The start running for each key, so starts for one key never overlap. */
  private readonly starting = new Map<string, Promise<unknown>>()
  private readonly launch: DaemonLauncher

  constructor(ctx: Context, private readonly config: E2BMachineConfig) {
    super(ctx)
    this.apiUrl = config.apiUrl.replace(/\/+$/u, '')
    this.fetch = config.fetch ?? globalThis.fetch
    this.launch = config.launch ?? e2bLauncher(config)
    if (!/^https:\/\//u.test(this.apiUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(this.apiUrl)) {
      throw new MachineError('the E2B API URL must use https:// (http:// only to this machine)', 'MACHINE_INVALID')
    }
  }

  async start(key: string, spec: BoxSpec): Promise<MachineRef> {
    validateBoxSpec(spec)
    const previous = this.starting.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.startOnce(key, spec))
    this.starting.set(key, run)
    try {
      return await run
    } finally {
      if (this.starting.get(key) === run) this.starting.delete(key)
    }
  }

  private async startOnce(key: string, spec: BoxSpec): Promise<MachineRef> {
    // A microVM is the strongest level there is, so every level is met.
    const existing = await this.find(key)
    if (existing && (existing.specHash ?? '') !== (spec.specHash ?? '')) {
      throw new MachineError(`machine ${key} runs an older environment; save its work, stop it and start again`, 'MACHINE_SPEC_CHANGED', { ref: existing.sandboxID })
    }
    const { env, firewall } = await this.network(spec)
    let ref: string
    if (existing) {
      if (existing.state === 'paused') await this.resume(existing.sandboxID)
      ref = existing.sandboxID
    } else {
      const created = await this.call('POST', '/v2/sandboxes', {
        templateID: spec.template,
        timeout: this.timeout,
        autoPause: true,
        autoPauseMemory: true,
        metadata: { ...spec.labels, [MACHINE_KEY_METADATA]: key, ...(spec.specHash ? { [SPEC_HASH_METADATA]: spec.specHash } : {}) },
        ...firewall,
      }, { 'idempotency-key': createAttempt(key, spec) })
      if (!isRecord(created) || typeof created.sandboxID !== 'string') throw new MachineError('E2B answered a create without a sandbox id', 'MACHINE_FAILED')
      ref = created.sandboxID
    }
    // A resumed box still runs its daemon; a new one, or one whose daemon died, gets it started here.
    await this.launch(ref, env)
    return { ref }
  }

  async pause(ref: string): Promise<void> {
    // 404: gone already; 409: already paused. Both are the state asked for.
    await this.call('POST', `/sandboxes/${encodeURIComponent(ref)}/pause`, { memory: true }, {}, [404, 409])
  }

  async stop(ref: string): Promise<void> {
    await this.call('DELETE', `/sandboxes/${encodeURIComponent(ref)}`, undefined, {}, [404])
  }

  async status(ref: string): Promise<MachineState> {
    const detail = await this.call('GET', `/sandboxes/${encodeURIComponent(ref)}`, undefined, {}, [404])
    if (detail === undefined) return 'missing'
    return isRecord(detail) && detail.state === 'paused' ? 'paused' : 'running'
  }

  private get timeout(): number {
    return this.config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  }

  private async resume(ref: string): Promise<void> {
    await this.call('POST', `/v2/sandboxes/${encodeURIComponent(ref)}/connect`, { timeout: this.timeout })
  }

  private async find(key: string): Promise<ListedSandbox | undefined> {
    const metadata = new URLSearchParams({ [MACHINE_KEY_METADATA]: key }).toString()
    const query = new URLSearchParams({ metadata, state: 'running,paused' })
    const listed = await this.call('GET', `/v2/sandboxes?${query.toString()}`)
    if (!Array.isArray(listed)) throw new MachineError('E2B answered the sandbox list with something other than a list', 'MACHINE_FAILED')
    // The server filters by metadata already; check again so a server that ignores the filter cannot hand back another box.
    const matches = listed.map(listedSandbox).filter((sandbox): sandbox is ListedSandbox => sandbox?.key === key)
    if (matches.length > 1) throw new MachineError(`two E2B sandboxes carry machine ${key}; stop one by hand`, 'MACHINE_FAILED')
    return matches[0]
  }

  /** The daemon's env and the box's firewall, from its network. E2B applies the firewall outside the VM. */
  private async network(spec: BoxSpec): Promise<{ env: Record<string, string>; firewall: Record<string, unknown> }> {
    const env = boxEnvironment(spec)
    if (spec.network.mode === 'open') return { env, firewall: { allow_internet_access: true } }
    const host = new URL(spec.daemon.serverUrl).hostname.replace(/^\[|\]$/gu, '')
    let server: string[]
    if (isIPv4(host)) {
      server = [host]
    } else {
      try {
        server = [...new Set((await (this.config.resolve ?? systemResolve)(host)).filter(address => isIPv4(address)))]
      } catch (error) {
        throw new MachineError(`could not resolve the server ${host}: ${error instanceof Error ? error.message : String(error)}`, 'MACHINE_UNAVAILABLE', { cause: error })
      }
      if (!server.length) throw new MachineError(`the server ${host} has no IPv4 address for the box firewall`, 'MACHINE_INVALID')
      env.TNEGA_HOSTS = server.map(address => `${address} ${host}`).join('\n')
    }
    const proxy = spec.network.mode === 'egress' ? spec.network.egress.proxyAddresses : []
    return {
      env,
      firewall: {
        allow_internet_access: false,
        // Addresses only, and no DNS servers: a name here would open DNS to the internet.
        network: { allowOut: [...proxy, ...server], denyOut: ['0.0.0.0/0'], dnsServers: [] },
      },
    }
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, absent: readonly number[] = []): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        headers: { 'x-api-key': this.config.apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new MachineError(`could not reach E2B at ${this.apiUrl}: ${error instanceof Error ? error.message : String(error)}`, 'MACHINE_UNAVAILABLE', { cause: error })
    }
    if (absent.includes(response.status)) return undefined
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 300)
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') message = parsed.message
      } catch { /* keep the raw text */ }
      const code = response.status === 401 || response.status === 403 ? 'MACHINE_UNAVAILABLE'
        : response.status === 400 || response.status === 404 ? 'MACHINE_INVALID' : 'MACHINE_FAILED'
      throw new MachineError(`E2B ${method} ${path.split('?')[0]} answered ${response.status}: ${message}`, code)
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new MachineError(`E2B ${method} ${path.split('?')[0]} answered with text that is not JSON`, 'MACHINE_FAILED')
    }
  }
}

export interface BoxTemplateBuild {
  apiUrl: string
  apiKey: string
  /** The template's name, `name` or `name:tag`. */
  name: string
  /** deploy/e2b/template, with a packed `tnega-*.tgz` in it. */
  directory: string
  cpuCount?: number
  memoryMB?: number
}

/**
 * Build the box template on E2B from deploy/e2b/template's Dockerfile (E2B's
 * template build v2; the old `e2b template build` stopped working in 2026).
 * It has no start command: the daemon starts per box, see above.
 */
export async function buildBoxTemplate(build: BoxTemplateBuild): Promise<BuildInfo> {
  const template = Template({ fileContextPath: build.directory }).fromDockerfile(join(build.directory, 'e2b.Dockerfile'))
  return await Template.build(template, build.name, {
    apiKey: build.apiKey,
    apiUrl: build.apiUrl,
    domain: e2bDomain(build.apiUrl),
    cpuCount: build.cpuCount ?? 2,
    memoryMB: build.memoryMB ?? 4096,
    onBuildLogs: defaultBuildLogger(),
  })
}

/** Plugin: provide `ctx.machines` from E2B. The composition layer mounts it. */
export const machineE2B = {
  name: 'machine-e2b',
  apply(ctx: Context, config: E2BMachineConfig): void {
    new E2BMachines(ctx, config)
  },
}

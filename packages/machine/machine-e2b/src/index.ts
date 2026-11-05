import type { Context } from '@tnega/core'
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
 *   create carries the key as its `Idempotency-Key` too, so two racing starts
 *   make one box. A box from another spec hash is refused, not reused.
 * - Pause keeps memory and disk; the box's shell, dev servers and jobs are
 *   still running when it resumes. A sandbox that times out pauses rather than
 *   dies, so nothing is lost when the server forgets to pause it.
 * - Network: with `egress`, the sandbox's firewall denies everything except
 *   the egress proxy and the server the daemon dials. E2B enforces it outside
 *   the VM, so a command inside cannot route around it.
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
  /** Replace `fetch` (tests). */
  fetch?: typeof globalThis.fetch
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

export class E2BMachines extends MachineService {
  readonly kind = 'e2b'
  private readonly apiUrl: string
  private readonly fetch: typeof globalThis.fetch

  constructor(ctx: Context, private readonly config: E2BMachineConfig) {
    super(ctx)
    this.apiUrl = config.apiUrl.replace(/\/+$/u, '')
    this.fetch = config.fetch ?? globalThis.fetch
    if (!/^https:\/\//u.test(this.apiUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(this.apiUrl)) {
      throw new MachineError('the E2B API URL must use https:// (http:// only to this machine)', 'MACHINE_INVALID')
    }
  }

  async start(key: string, spec: BoxSpec): Promise<MachineRef> {
    validateBoxSpec(spec)
    // A microVM is the strongest level there is, so every level is met.
    const existing = await this.find(key)
    if (existing) {
      if ((existing.specHash ?? '') !== (spec.specHash ?? '')) {
        throw new MachineError(`machine ${key} runs an older environment; save its work, stop it and start again`, 'MACHINE_SPEC_CHANGED', { ref: existing.sandboxID })
      }
      if (existing.state === 'paused') await this.resume(existing.sandboxID)
      return { ref: existing.sandboxID }
    }
    const created = await this.call('POST', '/v2/sandboxes', {
      templateID: spec.template,
      timeout: this.timeout,
      autoPause: true,
      autoPauseMemory: true,
      metadata: { ...spec.labels, [MACHINE_KEY_METADATA]: key, ...(spec.specHash ? { [SPEC_HASH_METADATA]: spec.specHash } : {}) },
      envVars: boxEnvironment(spec),
      ...this.network(spec),
    }, { 'idempotency-key': key })
    if (!isRecord(created) || typeof created.sandboxID !== 'string') throw new MachineError('E2B answered a create without a sandbox id', 'MACHINE_FAILED')
    return { ref: created.sandboxID }
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

  /** The sandbox's firewall, from the box's network. E2B applies it outside the VM. */
  private network(spec: BoxSpec): Record<string, unknown> {
    const server = new URL(spec.daemon.serverUrl).hostname.replace(/^\[|\]$/gu, '')
    switch (spec.network.mode) {
      case 'open':
        return { allow_internet_access: true }
      case 'none':
        return { allow_internet_access: false, network: { allowOut: [server], denyOut: ['0.0.0.0/0'] } }
      case 'egress':
        return {
          allow_internet_access: false,
          network: { allowOut: [...spec.network.egress.proxyAddresses, server], denyOut: ['0.0.0.0/0'] },
        }
    }
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, absent: readonly number[] = []): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method,
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

/** Plugin: provide `ctx.machines` from E2B. The composition layer mounts it. */
export const machineE2B = {
  name: 'machine-e2b',
  apply(ctx: Context, config: E2BMachineConfig): void {
    new E2BMachines(ctx, config)
  },
}

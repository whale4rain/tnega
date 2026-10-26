import type { Context } from '@tnega/core'
import {
  decideNetworkAccess,
  parseDomainPattern,
  resolveNetworkPolicy,
  type SandboxNetworkMode,
  type SandboxNetworkRequest,
} from '@tnega/sandbox'
import { optionalBoolean, record, stringField, ToolInputError, type ToolDefinition, type ToolExecuteOptions } from '@tnega/tools'

/**
 * `request_network_access`: the agent asks for domains its commands were refused, the
 * person decides on the usual approval card, and an approved call widens the command
 * network for the rest of the Session (or, with `remember`, for good).
 *
 * The tool never edits rules on its own authority: it runs only after the approval
 * guard let the call through, so the decision is the person's (or the reviewer they
 * chose). Grants are rebuilt from the Session's own `tool/result` events, so a resumed
 * Session keeps them and a replay shows who allowed what.
 */

export const NETWORK_ACCESS_TOOL = 'request_network_access'

/** The smallest view of a Session this package reads: its events. */
export interface GrantSource {
  read(): Promise<ReadonlyArray<{ type: string; payload: unknown }>>
}

/** Domains approved for this Session's commands, on top of the configured list. */
export class NetworkGrants {
  private readonly granted = new Set<string>()
  private seeded: Promise<void> | undefined

  constructor(private readonly session?: () => GrantSource | undefined) {}

  /** Approved domains, including those approved before this process started. */
  async list(): Promise<string[]> {
    if (this.seeded === undefined) {
      const log = this.session?.()
      // No Session mounted yet: try again on the next call instead of settling on none.
      if (log === undefined) return [...this.granted]
      this.seeded = this.seed(log).catch((error: unknown) => {
        this.seeded = undefined
        throw error
      })
    }
    await this.seeded
    return [...this.granted]
  }

  add(domains: readonly string[]): void {
    for (const domain of domains) this.granted.add(domain)
  }

  /** Read earlier approvals once from the Session's tool results. */
  private async seed(log: GrantSource): Promise<void> {
    for (const event of await log.read()) {
      if (event.type !== 'tool/result') continue
      const payload = event.payload
      if (!isRecord(payload) || payload.name !== NETWORK_ACCESS_TOOL || payload.ok !== true) continue
      const output = payload.output
      if (isRecord(output) && Array.isArray(output.granted)) {
        this.add(output.granted.filter((entry): entry is string => typeof entry === 'string' && grantable(entry)))
      }
    }
  }
}

/**
 * Merge Session grants into a configured request. Only `allowlist` takes grants:
 * `open` needs none, and `off` is the person's choice that no approval overrides.
 */
export async function withGrants(
  request: SandboxNetworkRequest | undefined,
  grants: NetworkGrants,
): Promise<SandboxNetworkRequest | undefined> {
  if (request?.mode !== 'allowlist') return request
  const extra = await grants.list()
  if (extra.length === 0) return request
  return { ...request, allowedDomains: [...new Set([...(request.allowedDomains ?? []), ...extra])] }
}

export interface ToolNetworkAccessConfig {
  grants: NetworkGrants
  /** The configured command network, read on every call. */
  network: () => Promise<SandboxNetworkRequest | undefined>
  /** Save domains to the configured allowed list ("always allow"); absent where nothing can be saved. */
  remember?: (domains: readonly string[]) => Promise<void>
}

const MAX_DOMAINS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A domain this tool may grant: readable, and never `*` (or `*:port`). */
function grantable(entry: string): boolean {
  const pattern = parseDomainPattern(entry)
  return pattern !== undefined && pattern.match !== 'any'
}

function domainList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ToolInputError('domains must be a non-empty array of domain names')
  if (value.length > MAX_DOMAINS) throw new ToolInputError(`ask for at most ${MAX_DOMAINS} domains at a time`)
  const domains = value.map(entry => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
  const bad = domains.filter(entry => !grantable(entry))
  if (bad.length > 0) {
    throw new ToolInputError(`not a domain this tool can grant: ${bad.map(entry => JSON.stringify(entry)).join(', ')}. Use names such as example.com, *.example.com or example.com:443; "*" is never granted`)
  }
  return [...new Set(domains)]
}

function modeOf(request: SandboxNetworkRequest | undefined): SandboxNetworkMode {
  return request?.mode ?? 'open'
}

/** Build `request_network_access` without registering it. */
export function createNetworkAccessTool(config: ToolNetworkAccessConfig): ToolDefinition {
  return {
    schema: {
      name: NETWORK_ACCESS_TOOL,
      description: 'Ask the user to let your commands reach domains the sandbox blocked (stderr says "tnega sandbox blocked host:port"). Needs approval; re-run the command after it is granted.',
      parameters: {
        type: 'object',
        properties: {
          domains: { type: 'array', items: { type: 'string' }, description: 'e.g. pypi.org, *.pythonhosted.org, example.com:443' },
          reason: { type: 'string', description: 'one line on why the task needs them' },
          remember: { type: 'boolean', description: 'ask to keep them allowed in Settings, not just this session' },
        },
        required: ['domains', 'reason'],
      },
    },
    // Approved once means approved: never ask again for the same call after a restart.
    interruption: 'fail',
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const domains = domainList(args.domains)
      stringField(args.reason, 'reason')
      const remember = optionalBoolean(args.remember, 'remember') === true
      // Fail closed without a permission guard: only a call a person (or their reviewer)
      // approved may widen the network.
      if (options.approvedElevation !== true) {
        return { granted: [], note: 'Nothing granted: this request was not approved. Commands keep the current network rules.' }
      }
      const configured = await config.network()
      const mode = modeOf(configured)
      if (mode === 'open') return { granted: [], note: 'Command network is open; nothing needs granting.' }
      if (mode === 'off') {
        return { granted: [], note: 'Command network is off in Settings, and that cannot be granted here. Tell the user what you need.' }
      }
      // Blocked domains stay blocked: only the person can take one off that list.
      const policy = resolveNetworkPolicy({ mode: 'allowlist', allowedDomains: domains, deniedDomains: configured?.deniedDomains ?? [] })
      const blocked = domains.filter(domain => {
        const host = parseDomainPattern(domain)
        return host !== undefined && host.match === 'exact' && decideNetworkAccess(policy, host.host, host.port ?? 443).reason === 'denied'
      })
      const granted = domains.filter(domain => !blocked.includes(domain))
      config.grants.add(granted)
      let remembered = false
      let saveFailed = false
      if (remember && config.remember !== undefined && granted.length > 0) {
        // The grant for this Session stands even if saving it for later fails.
        try {
          await config.remember(granted)
          remembered = true
        } catch {
          saveFailed = true
        }
      }
      return {
        granted,
        ...(blocked.length > 0 ? { stillBlocked: blocked } : {}),
        remembered,
        note: granted.length > 0
          ? `Allowed for ${remembered ? 'this and later sessions' : 'this session'}.${saveFailed ? ' Saving them to Settings failed, so later sessions will ask again.' : ''} Re-run the command.`
          : 'Nothing granted: these are on the blocked list in Settings.',
      }
    },
  }
}

/**
 * Mount: `await ctx.plugin(toolNetworkAccess, { grants, network, remember })`.
 * The composition merges `grants` into the sandbox policy with {@link withGrants}.
 */
export const toolNetworkAccess = {
  name: 'tool-network-access',
  inject: ['tools'],
  apply(ctx: Context, config: ToolNetworkAccessConfig): void {
    ctx.tools.register(createNetworkAccessTool(config))
  },
}

export const name = '@tnega/tool-network-access'

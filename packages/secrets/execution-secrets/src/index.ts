import type { Context } from '@tnega/core'
import type {
  BackgroundProcessRequest,
  BackgroundShellRequest,
  ExecutionProvider,
  ProcessRequest,
  ShellRequest,
} from '@tnega/process'
import { proxiedSecretPlaceholder, secretEnv, type SecretEntry } from '@tnega/secrets'

export interface SecretEnvOptions {
  /** Names the egress proxy adds itself; read at each call. Commands see a placeholder. */
  proxied?: () => readonly string[] | Promise<readonly string[]>
  /** Give commands no secret values at all, only the placeholders of proxied ones. */
  withholdOthers?: boolean
}

/**
 * `ctx.secrets` Consumer: an `ExecutionProvider` decorator that gives every
 * command and process this scope starts its secrets as environment variables.
 *
 * It reads the store at each call, so a key the user enters mid-turn reaches
 * the next command, and records what it handed over so masking still catches
 * those values once the store no longer holds them. With no store mounted it
 * passes requests through. A variable the caller sets itself wins over a secret
 * of the same name.
 *
 * Wrap the provider that spawns (the sandbox decorator's `inner`): the sandbox
 * then confines the command as usual and the variables ride along.
 *
 * In a box (v2) the keys stay out: a secret the egress proxy adds to requests
 * (`options.proxied`) reaches commands only as a placeholder
 * ({@link proxiedSecretPlaceholder}), and `options.withholdOthers` keeps every
 * other secret out of the box as well.
 */
export function secretEnvExecution(ctx: Context, inner: ExecutionProvider, options: SecretEnvOptions = {}): ExecutionProvider {
  async function env(own: Readonly<Record<string, string>> | undefined): Promise<Readonly<Record<string, string>> | undefined> {
    const store = ctx.get('secrets', false)
    if (!store) return own
    const entries = await store.entries()
    if (entries.length === 0) return own
    const proxied = new Set(await options.proxied?.() ?? [])
    const given: SecretEntry[] = []
    const placeholders: Record<string, string> = {}
    for (const entry of entries) {
      if (proxied.has(entry.name)) placeholders[entry.name] = proxiedSecretPlaceholder(entry.name)
      else if (!options.withholdOthers) given.push(entry)
    }
    // Masking keeps catching these once a command could have printed them,
    // even if the user removes one before the tool result comes back.
    if (given.length) store.noteInjected(given)
    return { ...secretEnv(given), ...placeholders, ...own }
  }
  const withEnv = async <T extends { env?: Readonly<Record<string, string>> }>(request: T): Promise<T> => {
    const merged = await env(request.env)
    return merged ? { ...request, env: merged } : request
  }

  const startShell = inner.startShell?.bind(inner)
  const startProcess = inner.startProcess?.bind(inner)
  return {
    async runShell(request: ShellRequest) {
      return inner.runShell(await withEnv(request))
    },
    async runProcess(request: ProcessRequest) {
      return inner.runProcess(await withEnv(request))
    },
    fetchHttp(request) {
      return inner.fetchHttp(request)
    },
    ...(inner.describeShell ? { describeShell: () => inner.describeShell!() } : {}),
    ...(startShell
      ? { startShell: async (request: BackgroundShellRequest) => startShell(await withEnv(request)) }
      : {}),
    ...(startProcess
      ? { startProcess: async (request: BackgroundProcessRequest) => startProcess(await withEnv(request)) }
      : {}),
  }
}

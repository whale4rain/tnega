import type { Context } from '@tnega/core'
import type {
  BackgroundProcessRequest,
  BackgroundShellRequest,
  ExecutionProvider,
  ProcessRequest,
  ShellRequest,
} from '@tnega/execution'
import { secretEnv } from '@tnega/secrets'

/**
 * `ctx.secrets` Consumer: an `ExecutionProvider` decorator that gives every
 * command and process this scope starts its secrets as environment variables.
 *
 * It reads the store at each call, so a key the user enters mid-turn reaches
 * the next command. With no store mounted it passes requests through. A
 * variable the caller sets itself wins over a secret of the same name.
 *
 * Wrap the provider that spawns (the sandbox decorator's `inner`): the sandbox
 * then confines the command as usual and the variables ride along.
 */
export function secretEnvExecution(ctx: Context, inner: ExecutionProvider): ExecutionProvider {
  async function env(own: Readonly<Record<string, string>> | undefined): Promise<Readonly<Record<string, string>> | undefined> {
    const store = ctx.get('secrets', false)
    const entries = store ? await store.entries() : []
    if (entries.length === 0) return own
    return { ...secretEnv(entries), ...own }
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
    ...(startShell
      ? { startShell: async (request: BackgroundShellRequest) => startShell(await withEnv(request)) }
      : {}),
    ...(startProcess
      ? { startProcess: async (request: BackgroundProcessRequest) => startProcess(await withEnv(request)) }
      : {}),
  }
}

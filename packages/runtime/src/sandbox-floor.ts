import type { PermissionMode } from '@tnega/approval-host'
import type { BackgroundShellRequest, ExecutionProvider, ShellRequest } from '@tnega/process'

/**
 * A scope whose commands always run in the sandbox (a server member's): the
 * person cannot pick `bypass`, and an approved escalation stays confined.
 * Approving one's own escalation must not be a way round the sandbox.
 */

/** What a scope that requires the sandbox runs at: `bypass` becomes `workspace-write`. */
export function sandboxedPermission(permission: PermissionMode): PermissionMode {
  return permission === 'bypass' ? 'workspace-write' : permission
}

export const ESCALATION_REFUSED_NOTE = 'This account always runs commands in the sandbox, so escalate was ignored.'

function confined<T extends ShellRequest | BackgroundShellRequest>(request: T): T {
  return request.unsandboxed ? { ...request, unsandboxed: false } : request
}

/** Drop `unsandboxed` from every request, so the sandbox decorator under it confines them all. */
export function withoutEscalation(provider: ExecutionProvider): ExecutionProvider {
  const startShell = provider.startShell?.bind(provider)
  const startProcess = provider.startProcess?.bind(provider)
  const describeShell = provider.describeShell?.bind(provider)
  return {
    async runShell(request) {
      const result = await provider.runShell(confined(request))
      if (!request.unsandboxed) return result
      return { ...result, stderr: `${result.stderr}${result.stderr === '' || result.stderr.endsWith('\n') ? '' : '\n'}${ESCALATION_REFUSED_NOTE}\n` }
    },
    runProcess: request => provider.runProcess(request),
    fetchHttp: request => provider.fetchHttp(request),
    ...(startShell ? { startShell: (request: BackgroundShellRequest) => startShell(confined(request)) } : {}),
    ...(startProcess ? { startProcess } : {}),
    ...(describeShell ? { describeShell } : {}),
  }
}

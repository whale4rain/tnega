import type { ToolExecuteOptions } from './index.js'

/**
 * Escalation: a shell command that the sandbox blocks can ask to run outside
 * it. The request is visible in the tool input (`escalate`, `justification`),
 * so whoever approves the call — a person or the automatic reviewer — sees
 * what they are approving; only an approved call is actually unsandboxed.
 */
export const ESCALATE_HINT = 'If the sandbox blocks a command that genuinely needs it (for example a build or dev server that starts child processes), set escalate: true with a one-line justification; it then needs approval and runs outside the sandbox.'

export const ESCALATE_PROPERTIES = {
  escalate: { type: 'boolean', description: 'Ask to run outside the sandbox. Needs approval; use only after the sandbox blocked the command.' },
  justification: { type: 'string', description: 'With escalate: why this command must run outside the sandbox, in one line.' },
} as const

/**
 * Whether this call runs outside the sandbox: it asked to, and the permission
 * guard approved this very call (a person or the reviewer said yes).
 */
export function escalated(args: Record<string, unknown>, options: ToolExecuteOptions): boolean {
  return args.escalate === true && options.approvedElevation === true
}

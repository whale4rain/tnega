import type { ToolPolicy, ToolResult, ToolRequest } from '@tnega/tools'

import type { TaskPermissions } from './types.js'

const DEFAULT_TOOL_WHITELIST = [
  'calculator',
  'json',
  'read_file',
  'write_file',
  'list_dir',
  'glob',
  'grep',
] as const

export interface EvalToolPolicyOptions {
  workspace: string
  permissions?: TaskPermissions
  maxOutputBytes?: number
}

function commandMatches(prefixes: string[] | undefined, command: string): boolean {
  if (!prefixes?.length) return false
  return prefixes.some(
    prefix => command === prefix
      || command.startsWith(`${prefix} `)
      || command.startsWith(`${prefix}\n`),
  )
}

function shellCommand(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>).command
  return typeof value === 'string' ? value : ''
}

export function createEvalToolPolicy(options: EvalToolPolicyOptions): ToolPolicy {
  const permissions = options.permissions ?? {}
  const whitelist = permissions.tools ?? DEFAULT_TOOL_WHITELIST
  const shellPolicy = permissions.shell
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024

  return {
    async authorizer(request: ToolRequest): Promise<boolean> {
      if (request.name === 'http_get') return permissions.network === true
      if (request.name === 'shell') {
        if (!shellPolicy?.enabled) return false
        const command = shellCommand(request.input)
        return commandMatches(shellPolicy.allow, command)
          && !commandMatches(shellPolicy.deny, command)
      }
      return (whitelist as readonly string[]).includes(request.name)
    },
    async truncator(result: ToolResult): Promise<ToolResult> {
      if (typeof result.output !== 'string' || result.output.length <= maxOutputBytes) {
        return result
      }
      return {
        ...result,
        output: result.output.slice(0, maxOutputBytes),
      }
    },
  }
}

import type { ToolDefinition } from '@tnega/tools'
import type { SessionMode } from '@tnega/session'
import type { SlashCommand, SlashCommandResult } from './types.js'
export type { SlashCommandResult } from './types.js'

export interface SlashContext {
  tools: readonly ToolDefinition[]
  cwd: string
  mode?: SessionMode
}

export type SlashHandler = (
  args: string[],
  context: SlashContext,
) => SlashCommandResult | Promise<SlashCommandResult>

export class SlashRegistry {
  private _commands = new Map<string, { description: string; handler: SlashHandler }>()

  register(name: string, description: string, handler: SlashHandler): void {
    const normalized = name.startsWith('/') ? name : `/${name}`
    if (this._commands.has(normalized)) {
      throw new Error(`slash command already registered: ${normalized}`)
    }
    this._commands.set(normalized, { description, handler })
  }

  list(): SlashCommand[] {
    return [...this._commands.entries()].map(([name, entry]) => ({
      name,
      description: entry.description,
    }))
  }

  async run(name: string, args: string[], context: SlashContext): Promise<SlashCommandResult> {
    const normalized = name.startsWith('/') ? name : `/${name}`
    const entry = this._commands.get(normalized)
    if (!entry) {
      return { kind: 'text', text: `unknown slash command: ${normalized}` }
    }
    return entry.handler(args, context)
  }

  has(name: string): boolean {
    return this._commands.has(name.startsWith('/') ? name : `/${name}`)
  }
}

export function createSlashRegistry(): SlashRegistry {
  const registry = new SlashRegistry()
  registry.register(
    '/plan',
    'Generate an implementation plan before executing. Used in plan and execute modes.',
    () => ({ kind: 'text', text: '/plan is handled by the session run pipeline.' }),
  )
  registry.register(
    '/mode',
    'Switch the session mode: auto, plan (plan then execute), or execute (use the current plan).',
    (_args, context) => ({
      kind: 'json',
      value: {
        modes: ['auto', 'plan', 'execute'],
        current: context.mode ?? 'auto',
      },
    }),
  )
  registry.register('/skills', 'List skills available in the workspace.', (_args, context) => ({
    kind: 'json',
    value: {
      skills: context.tools
        .filter(tool => tool.schema.name.startsWith('skill'))
        .map(tool => tool.schema.name),
    },
  }))
  registry.register('/mcp', 'Show connected MCP servers and their tools.', (_args, context) => ({
    kind: 'json',
    value: {
      tools: context.tools
        .filter(tool => tool.schema.name.startsWith('mcp__'))
        .map(tool => tool.schema.name),
    },
  }))
  return registry
}

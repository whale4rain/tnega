import type { ToolDefinition } from '@tnega/tools'
import type { SessionMode } from '@tnega/session'
import type { SlashCommand, SlashCommandResult } from './types.js'
export type { SlashCommandResult } from './types.js'

export interface SlashContext {
  tools: readonly ToolDefinition[]
  cwd: string
  mode?: SessionMode
  setMode?: (mode: SessionMode) => void | Promise<void>
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
    'Show or switch the session mode: /mode, /mode plan, /mode execute, /mode auto.',
    async (args, context) => {
      const modes: SessionMode[] = ['auto', 'plan', 'execute']
      if (!args.length) {
        return {
          kind: 'json',
          value: {
            modes,
            current: context.mode ?? 'auto',
          },
        }
      }
      const requested = args[0]!.trim().toLowerCase()
      if (!modes.includes(requested as SessionMode)) {
        return {
          kind: 'text',
          text: `invalid mode: ${args[0]}; expected auto, plan or execute`,
        }
      }
      const next = requested as SessionMode
      if (!context.setMode) {
        return {
          kind: 'text',
          text: 'mode switching is not available in this context',
        }
      }
      await context.setMode(next)
      return {
        kind: 'json',
        value: {
          modes,
          current: next,
          switched: true,
        },
      }
    },
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

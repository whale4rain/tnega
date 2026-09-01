import type { ToolDefinition } from '@tnega/tools'
import type { SessionMode } from '@tnega/session'
import { listSkills, readSkill, type SkillEntry } from './skills.js'
import type { McpSurvey } from './mcp.js'
import type { SlashCommand, SlashCommandResult, SlashSuggestion } from './types.js'
export type { SlashCommandResult, SlashSuggestion } from './types.js'

export interface SlashContext {
  tools: readonly ToolDefinition[]
  cwd: string
  mode?: SessionMode
  setMode?: (mode: SessionMode) => void | Promise<void>
  skills?: SkillEntry[]
  mcp?: {
    surveys: McpSurvey[]
    tools: readonly ToolDefinition[]
  }
}

export type SlashHandler = (
  args: string[],
  context: SlashContext,
) => SlashCommandResult | Promise<SlashCommandResult>

export type SlashSuggester = (
  context: SlashContext,
) => SlashSuggestion[] | Promise<SlashSuggestion[]>

export class SlashRegistry {
  private _commands = new Map<string, {
    description: string
    handler: SlashHandler
    suggest?: SlashSuggester
  }>()

  register(
    name: string,
    description: string,
    handler: SlashHandler,
    suggest?: SlashSuggester,
  ): void {
    const normalized = name.startsWith('/') ? name : `/${name}`
    if (this._commands.has(normalized)) {
      throw new Error(`slash command already registered: ${normalized}`)
    }
    this._commands.set(normalized, suggest
      ? { description, handler, suggest }
      : { description, handler })
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

  async suggest(name: string, context: SlashContext): Promise<SlashSuggestion[]> {
    const normalized = name.startsWith('/') ? name : `/${name}`
    const entry = this._commands.get(normalized)
    return entry?.suggest ? entry.suggest(context) : []
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
  registry.register(
    '/skills',
    'List workspace skills, or read one with /skills <name>.',
    async (args, context) => {
      const skills = context.skills ?? await listSkills(context.cwd)
      if (!args.length) {
        return {
          kind: 'json',
          value: {
            skills: skills.map(skill => ({
              name: skill.name,
              description: skill.description,
            })),
          },
        }
      }
      const name = args[0]!
      const known = skills.some(skill => skill.name === name)
      if (!known) {
        return {
          kind: 'text',
          text: `unknown skill: ${name}`,
        }
      }
      const content = await readSkill(context.cwd, name)
      return {
        kind: 'text',
        text: `# ${name}\n\n${content}`,
      }
    },
    async (context) => {
      const skills = context.skills ?? await listSkills(context.cwd)
      return skills.map(skill => ({
        command: '/skills',
        args: [skill.name],
        label: skill.name,
        detail: skill.description,
      }))
    },
  )
  registry.register(
    '/mcp',
    'Show connected MCP servers and their tools.',
    async (args, context) => {
      const surveys = context.mcp?.surveys ?? []
      const tools = (context.mcp?.tools ?? context.tools)
        .filter(tool => tool.schema.name.startsWith('mcp__'))
      if (args.length === 0) {
        return {
          kind: 'json',
          value: {
            servers: surveys.map(survey => ({
              name: survey.name,
              status: survey.status,
              toolCount: survey.toolCount,
              ...(survey.error ? { error: survey.error } : {}),
            })),
            tools: tools.map(tool => tool.schema.name),
          },
        }
      }
      const serverName = args[0]!
      const survey = surveys.find(entry => entry.name === serverName)
      if (!survey) {
        return {
          kind: 'text',
          text: `unknown mcp server: ${serverName}`,
        }
      }
      const serverTools = tools.filter(tool =>
        tool.schema.name.startsWith(`mcp__${serverName}__`),
      )
      if (args.length === 1) {
        return {
          kind: 'json',
          value: {
            server: {
              name: survey.name,
              status: survey.status,
              toolCount: survey.toolCount,
              ...(survey.error ? { error: survey.error } : {}),
            },
            tools: serverTools.map(tool => tool.schema.name),
          },
        }
      }
      const toolName = args.slice(1).join('__')
      const tool = serverTools.find(entry =>
        entry.schema.name === `mcp__${serverName}__${toolName}`,
      )
      if (!tool) {
        return {
          kind: 'text',
          text: `unknown mcp tool: ${args.slice(1).join(' ')} on server ${serverName}`,
        }
      }
      return {
        kind: 'json',
        value: {
          server: survey.name,
          tool: tool.schema.name,
          description: tool.schema.description,
          schema: tool.schema.parameters ?? {},
        },
      }
    },
    async (context) => {
      const surveys = context.mcp?.surveys ?? []
      const tools = (context.mcp?.tools ?? context.tools)
        .filter(tool => tool.schema.name.startsWith('mcp__'))
      const suggestions: SlashSuggestion[] = []
      for (const survey of surveys) {
        suggestions.push({
          command: '/mcp',
          args: [survey.name],
          label: survey.name,
          detail: `${survey.status} / ${survey.toolCount} tools`,
        })
      }
      for (const tool of tools) {
        const parts = tool.schema.name.split('__')
        const server = parts[1]
        if (parts[0] === 'mcp' && server) {
          suggestions.push({
            command: '/mcp',
            args: [server, parts.slice(2).join('__')],
            label: tool.schema.name,
            detail: tool.schema.description,
          })
        }
      }
      return suggestions
    },
  )
  return registry
}

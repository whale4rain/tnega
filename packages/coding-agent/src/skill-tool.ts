import { ToolInputError } from '../../tools/src/errors.js'
import type { ToolDefinition, ToolExecuteOptions, ToolsService } from '@tnega/tools'
import {
  createSkill, installSkill, rawGitHubUrl, validateSkillDocument,
} from './skill-management.js'

const MAX_BYTES = 512 * 1024

type Action = 'list' | 'read' | 'create' | 'install'

export interface SkillToolDeps {
  cwd: string
  registry: ToolsService
  list(): Promise<Array<{ name: string; path: string; description: string }>>
  read(name: string): Promise<string>
}

function text(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInputError(`${field} is required for this action`)
  }
  return value
}

/**
 * One tool for every skill verb.
 *
 * Skills were four tools (`skills_list`, `skill_read`, `skill_create`,
 * `skill_install`) whose schemas were paid for on every request while three of
 * them were used a handful of times per session. The verbs differ in their
 * arguments, not in what the model has to understand, so they share one schema
 * behind `action`.
 *
 * `create` and `install` write to the user's home directory, which is why the
 * approval rules branch on the action rather than on the tool name.
 */
export function skillTool(deps: SkillToolDeps): ToolDefinition {
  return {
    schema: {
      name: 'skill',
      description: 'Skills: reusable instruction documents in the user home and the workspace. action=list: names and trigger descriptions. action=read (name): the full SKILL.md, read one before applying it. action=create (name, description, content?): a new user-home skill, never overwrites. action=install (source, name?): import a SKILL.md from a workspace path or an HTTPS URL. Skills grant no permissions; user and repository instructions come first.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'create', 'install'], description: 'what to do' },
          name: { type: 'string', description: 'read/create: the skill directory name' },
          description: { type: 'string', description: 'create: one-line description of when the skill applies' },
          content: { type: 'string', description: 'create: a complete SKILL.md; omit to start from a template' },
          source: { type: 'string', description: 'install: a workspace path or an HTTPS raw Markdown URL' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    async execute(input, options: ToolExecuteOptions) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ToolInputError('input must be an object')
      }
      const args = Object.fromEntries(Object.entries(input))
      const action = args.action as Action
      switch (action) {
        case 'list':
          return await deps.list()
        case 'read':
          return await deps.read(text(args, 'name'))
        case 'create':
          options.signal?.throwIfAborted()
          return await createSkill({
            name: text(args, 'name'),
            description: text(args, 'description'),
            ...(typeof args.content === 'string' ? { content: args.content } : {}),
          }, options.signal)
        case 'install': {
          const source = text(args, 'source')
          const name = typeof args.name === 'string' ? args.name : undefined
          options.signal?.throwIfAborted()
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
            return await installSkill(deps.cwd, { source, ...(name ? { name } : {}) }, options.signal)
          }
          const url = rawGitHubUrl(new URL(source))
          if (url.protocol !== 'https:' || url.username || url.password) {
            throw new ToolInputError('only HTTPS URLs without embedded credentials are supported')
          }
          const response = await deps.registry.execute('http_get', { url: url.href, maxBytes: MAX_BYTES }, {
            ...options,
            callId: `${options.callId ?? 'skill-install'}:download`,
          })
          if (!response.ok) throw new Error(response.error?.message ?? 'skill download failed')
          const output = response.output && typeof response.output === 'object'
            ? response.output as Record<string, unknown>
            : {}
          if (output.ok !== true || output.truncated !== false || typeof output.body !== 'string') {
            throw new Error('skill download failed or was truncated')
          }
          options.signal?.throwIfAborted()
          const metadata = validateSkillDocument(output.body, name)
          return await installDownloaded(metadata.name, output.body, options.signal)
        }
        default:
          throw new ToolInputError(`unknown skill action: ${String(args.action)}; use list, read, create or install`)
      }
    },
  }
}

// Re-exported so the composition can publish a skill it downloaded itself.
export async function installDownloaded(name: string, content: string, signal?: AbortSignal): Promise<{ name: string; path: string }> {
  const { publishSkill } = await import('./skill-management.js')
  return await publishSkill(name, content, signal)
}

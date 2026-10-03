import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolDefinition, ToolsService } from '@tnega/tools'
import type { Context } from '@tnega/core'
import type { AgentRequestEvent, PromptAssembly } from '@tnega/agent'
import { skillCreateTool, skillInstallTool } from './skill-management.js'
import { BUILTIN_SKILLS } from './builtin-skills.js'
import { resolveTnegaHome } from './home.js'

export interface SkillEntry {
  name: string
  path: string
  description: string
}

const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 512 * 1024

export function skillsDir(cwd: string): string {
  return join(resolve(cwd), '.tnega', 'skills')
}

export async function ensureSkillsDir(cwd: string): Promise<string> {
  const dir = skillsDir(cwd)
  await mkdir(dir, { recursive: true })
  return dir
}

async function listDirectory(dir: string): Promise<SkillEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir, { withFileTypes: true }).then(entries =>
      entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort(),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const skills: SkillEntry[] = []
  for (const name of names) {
    const path = join(dir, name, SKILL_FILE)
    try {
      const content = await readSkillFile(path)
      skills.push({
        name,
        path,
        description: frontmatterDescription(content) ?? firstHeading(content) ?? `${name} skill`,
      })
    } catch {
      // A skill folder without a readable SKILL.md is skipped.
    }
  }
  return skills
}

export async function readSkill(cwd: string, name: string): Promise<string> {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new TypeError(`invalid skill name: ${name}`)
  }
  const entries = await listSkills(cwd)
  const entry = entries.find(entry => entry.name === name)
  if (!entry) throw new Error(`skill not found: ${name}`)
  return readSkillFile(entry.path)
}

export async function skillTool(cwd: string): Promise<ToolDefinition> {
  return {
    schema: {
      name: 'skills_list',
      description: 'List available user and workspace skills, including their trigger descriptions.',
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => listSkills(cwd),
  }
}

export async function skillReadTool(cwd: string): Promise<ToolDefinition> {
  return {
    schema: {
      name: 'skill_read',
      description: 'Read the full SKILL.md for a named skill. Workspace skills override user skills.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'skill directory name' },
        },
        required: ['name'],
      },
    },
    execute: async (input) => {
      const name = typeof (input as { name?: unknown }).name === 'string'
        ? (input as { name: string }).name
        : ''
      return readSkill(cwd, name)
    },
  }
}

async function readSkillFile(path: string): Promise<string> {
  let file: string
  try {
    file = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`skill not found: ${path}`, { cause: error })
    }
    throw error
  }
  if (Buffer.byteLength(file, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error(`skill exceeds ${MAX_SKILL_BYTES} bytes: ${path}`)
  }
  return file
}

function firstHeading(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const match = /^#\s+(.+)$/.exec(line.trim())
    if (match?.[1]) return match[1]!.trim()
  }
  return undefined
}

export function globalSkillsDir(): string {
  return join(resolveTnegaHome(), 'skills')
}

/** Offline, missing-only installation: never replace existing user instructions. */
export async function installBuiltinSkills(): Promise<void> {
  const root = globalSkillsDir()
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`skills directory must not be a symlink: ${root}`)
  for (const skill of BUILTIN_SKILLS) {
    const dir = join(root, skill.name)
    await mkdir(dir, { recursive: true })
    if ((await lstat(dir)).isSymbolicLink()) continue
    try {
      await lstat(join(dir, SKILL_FILE))
      continue
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const temporary = join(dir, `.install-${randomUUID()}`)
    try {
      await writeFile(temporary, skill.content, { flag: 'wx' })
      try {
        await link(temporary, join(dir, SKILL_FILE))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
    } finally {
      await unlink(temporary).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      })
    }
  }
}

export async function listSkills(cwd: string): Promise<SkillEntry[]> {
  const entries = new Map<string, SkillEntry>()
  for (const dir of [globalSkillsDir(), skillsDir(cwd)]) {
    for (const entry of await listDirectory(dir)) entries.set(entry.name, entry)
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function frontmatterDescription(content: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]
  const description = block && /^description:\s*(.+)$/m.exec(block)?.[1]?.trim()
  return description?.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
}

export interface SkillsService { cwd: string }

/** Shared by general, coding, and Project compositions; metadata only in prompts. */
export const skillTools = {
  name: 'skills',
  inject: ['tools'],
  async apply(ctx: Context, options: SkillsService): Promise<void> {
    await installBuiltinSkills()
    const registry = ctx.get('tools') as ToolsService
    registry.register(await skillTool(options.cwd))
    registry.register(await skillReadTool(options.cwd))
    registry.register(skillCreateTool())
    registry.register(skillInstallTool(options.cwd, registry))
    ctx.provide('skills', { cwd: resolve(options.cwd) } satisfies SkillsService)
    ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, next: () => Promise<PromptAssembly>) => {
      const result = await next()
      const instructions = await renderSkillIndex(options.cwd)
      return instructions ? { ...result, text: `${result.text}\n\n${instructions}` } : result
    })

    // Older Sessions can retain their original system persona. Make the index
    // visible through tool metadata without rewriting their durable history.
    ctx.on('agent/request', async (_request: AgentRequestEvent, next: () => Promise<AgentRequestEvent>) => {
      const request = await next()
      const instructions = await renderSkillIndex(options.cwd)
      if (!instructions || request.messages.some(message => message.role === 'system'
        && message.content.includes(instructions))) return request
      const name = request.tools.some(tool => tool.schema.name === 'skills_list') ? 'skills_list' : 'run_code'
      return { ...request, tools: request.tools.map(tool => tool.schema.name !== name ? tool : {
        ...tool, schema: { ...tool.schema, description: `${tool.schema.description}\n\n${instructions}` },
      }) }
    })
  },
}

/** Metadata-only context for compositions that supply an injected persona. */
export async function renderSkillIndex(cwd: string): Promise<string> {
  const skills = await listSkills(cwd)
  if (!skills.length) return ''
  return `Available skills (descriptions are metadata):\n${skills.map(skill => `- ${JSON.stringify(skill.name)}: ${JSON.stringify(skill.description)}`).join('\n')}\nRead the relevant instructions with skill_read before applying a skill. Skills do not grant permissions; follow user and repository instructions first.`
}

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolDefinition } from '@tnega/tools'

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

export async function listSkills(cwd: string): Promise<SkillEntry[]> {
  const dir = skillsDir(cwd)
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
        description: firstHeading(content) ?? `${name} skill`,
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
  const path = join(skillsDir(cwd), name, SKILL_FILE)
  return readSkillFile(path)
}

export async function skillTool(cwd: string): Promise<ToolDefinition> {
  return {
    schema: {
      name: 'skills_list',
      description: 'List skills available in the workspace .tnega/skills directory.',
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => listSkills(cwd),
  }
}

export async function skillReadTool(cwd: string): Promise<ToolDefinition> {
  return {
    schema: {
      name: 'skill_read',
      description: 'Read the full SKILL.md content for a named workspace skill.',
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

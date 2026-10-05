import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveInside, type ToolDefinition, type ToolExecuteOptions, type ToolsService } from '@tnega/tools'
import { resolveTnegaHome } from './home.js'

const MAX_BYTES = 512 * 1024
export interface CreateSkillInput { name: string; description: string; content?: string }
export interface InstallSkillInput { source: string; name?: string }

function validateName(name: string): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 64
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)) throw new TypeError('invalid skill name; use lowercase letters, numbers and hyphens')
}
function validateDocument(content: string, expectedName?: string): { name: string; description: string } {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('skill exceeds 512 KiB')
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]
  if (!block) throw new Error('skill requires frontmatter with name and description')
  const field = (key: string): string => (new RegExp(`^${key}: *(.+)$`, 'm').exec(block)?.[1] ?? '').trim().replace(/^['"](.*)['"]$/, '$1')
  const name = field('name')
  const description = field('description')
  validateName(name)
  if (expectedName && name !== expectedName) throw new Error('skill frontmatter name must match the requested name')
  if (!description || description.length > 1024 || /[\r\n]/.test(description)) throw new Error('skill requires a single-line description of at most 1024 characters')
  return { name, description }
}
async function publish(name: string, content: string, signal?: AbortSignal): Promise<{ name: string; path: string }> {
  signal?.throwIfAborted()
  const root = join(resolveTnegaHome(), 'skills')
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('skills directory must not be a symlink')
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('skill directory must not be a symlink')
  const path = join(directory, 'SKILL.md')
  const temporary = join(directory, `.install-${randomUUID()}`)
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    signal?.throwIfAborted()
    try { await link(temporary, path) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error(`skill already exists: ${name}`, { cause: error })
      throw error
    }
  } finally { await unlink(temporary).catch(error => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }) }
  return { name, path }
}
export async function createSkill(input: CreateSkillInput, signal?: AbortSignal): Promise<{ name: string; path: string }> {
  validateName(input.name)
  if (!input.description.trim() || input.description.length > 1024 || /[\r\n]/.test(input.description)) throw new TypeError('description must be a non-empty single line of at most 1024 characters')
  const content = input.content ?? `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description.trim())}\n---\n\n# ${input.name}\n\nFollow user and repository instructions first.\n\n## Workflow\n\nDescribe the steps, available tools, and verification that apply to this task.\n`
  validateDocument(content, input.name)
  return publish(input.name, content, signal)
}
export async function installSkill(cwd: string, input: InstallSkillInput, signal?: AbortSignal): Promise<{ name: string; path: string }> {
  const source = await resolveInside(cwd, input.source)
  const file = (await lstat(source)).isDirectory() ? await resolveInside(cwd, join(source, 'SKILL.md')) : source
  if ((await stat(file)).size > MAX_BYTES) throw new Error('skill exceeds 512 KiB')
  const content = await readFile(file, 'utf8')
  const metadata = validateDocument(content, input.name)
  return publish(metadata.name, content, signal)
}
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('expected an object')
  return Object.fromEntries(Object.entries(input))
}
function textField(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value
}
export function skillCreateTool(): ToolDefinition {
  return {
    schema: { name: 'skill_create', description: 'Create a new user-home skill with a template or complete SKILL.md. Never overwrite existing skills.', parameters: {
      type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'description'], additionalProperties: false,
    } },
    execute: (input, options) => {
      options.signal?.throwIfAborted()
      const args = record(input)
      return createSkill({ name: textField(args, 'name'), description: textField(args, 'description'), ...(typeof args.content === 'string' ? { content: args.content } : {}) }, options.signal)
    },
  }
}
/**
 * A GitHub page link (`github.com/o/r/blob/main/SKILL.md`) serves HTML; the
 * file itself is on raw.githubusercontent.com.
 */
export function rawGitHubUrl(url: URL): URL {
  const match = url.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname) : null
  return match ? new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`) : url
}

export function skillInstallTool(cwd: string, registry: ToolsService): ToolDefinition {
  return {
    schema: { name: 'skill_install', description: 'Install a SKILL.md from a workspace file/directory or HTTPS raw Markdown URL into user home. Copies only instructions, never scripts or assets; existing files are not overwritten. HTTPS requires the http_get tool.', parameters: {
      type: 'object', properties: { source: { type: 'string' }, name: { type: 'string' } }, required: ['source'], additionalProperties: false,
    } },
    execute: async (input, options: ToolExecuteOptions) => {
      const args = record(input)
      options.signal?.throwIfAborted()
      const source = textField(args, 'source')
      const name = typeof args.name === 'string' ? args.name : undefined
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return installSkill(cwd, { source, ...(name ? { name } : {}) }, options.signal)
      const url = rawGitHubUrl(new URL(source))
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('only HTTPS URLs without embedded credentials are supported')
      const response = await registry.execute('http_get', { url: url.href, maxBytes: MAX_BYTES }, { ...options, callId: `${options.callId ?? 'skill-install'}:download` })
      if (!response.ok) throw new Error(response.error?.message ?? 'skill download failed')
      const output = record(response.output)
      if (output.ok !== true || output.truncated !== false || typeof output.body !== 'string') throw new Error('skill download failed or was truncated')
      options.signal?.throwIfAborted()
      const metadata = validateDocument(output.body, name)
      return publish(metadata.name, output.body, options.signal)
    },
  }
}

import type { ToolView } from './timeline'

export type ToolFamily = 'read' | 'write' | 'search' | 'shell' | 'web' | 'agent' | 'memory' | 'other'

interface ToolPresentation {
  family: ToolFamily
  verb: string
  target?: string
}

const FAMILY: Record<string, ToolFamily> = {
  read_file: 'read',
  list_dir: 'read',
  skill_read: 'read',
  skills_list: 'read',
  read_artifact: 'read',
  read_project: 'read',
  write_file: 'write',
  edit_file: 'write',
  apply_patch: 'write',
  publish_artifact: 'write',
  glob: 'search',
  grep: 'search',
  shell: 'shell',
  http_get: 'web',
  web_search: 'web',
  web_fetch: 'web',
  spawn_subagent: 'agent',
  list_subagent: 'agent',
  send_agent_message: 'agent',
  spawn_thread: 'agent',
  list_threads: 'agent',
  send_thread_message: 'agent',
  remember_global: 'memory',
  write_memory: 'memory',
  get_goal: 'memory',
  update_goal: 'memory',
}

const VERB: Record<string, [running: string, done: string]> = {
  read_file: ['Reading', 'Read'],
  list_dir: ['Listing', 'Listed'],
  write_file: ['Writing', 'Wrote'],
  edit_file: ['Editing', 'Edited'],
  glob: ['Finding files', 'Found files'],
  grep: ['Searching', 'Searched'],
  shell: ['Running', 'Ran'],
  http_get: ['Fetching', 'Fetched'],
  web_search: ['Searching the web', 'Searched the web'],
  skill_read: ['Reading skill', 'Read skill'],
  remember_global: ['Remembering', 'Remembered'],
  write_memory: ['Saving memory', 'Saved memory'],
  update_goal: ['Updating goal', 'Updated goal'],
}

/** Failures a person has to act on: setup, permissions or a missing tool. */
const ATTENTION_NAMES = new Set(['ToolAuthorizationError', 'ToolNotFoundError', 'SandboxUnavailableError', 'SandboxError'])
const ATTENTION_MESSAGE = /SANDBOX_UNAVAILABLE|cannot run inside the Windows sandbox|api[ _-]?key|not configured|unauthori[sz]ed|\b401\b|quota/i

/**
 * Whether a tool failure is shown to the person as a failure. Most errors
 * (a 404, a missing file, invalid input, a non-matching search) are ordinary
 * feedback the model reads and works around; those stay quiet in the
 * timeline. The model's context is unaffected either way.
 */
export function needsAttention(tool: ToolView): boolean {
  if (tool.status !== 'error') return false
  if (tool.errorName && ATTENTION_NAMES.has(tool.errorName)) return true
  return ATTENTION_MESSAGE.test(tool.error ?? '')
}

const TARGET_KEYS = ['command', 'path', 'pattern', 'query', 'url', 'name', 'expression', 'objective', 'label']

export function presentTool(tool: ToolView): ToolPresentation {
  if (tool.name === 'run_code') {
    const names = [...new Set(tool.children?.map(child => child.name) ?? [])]
    return { family: 'other', verb: 'CodeMode', target: names.length ? names.join(' · ') : 'JavaScript' }
  }
  const family = FAMILY[tool.name] ?? 'other'
  const verbs = VERB[tool.name]
  const verb = verbs
    ? verbs[tool.status === 'running' ? 0 : 1]
    : humanize(tool.name)
  const target = toolTarget(tool.args)
  return { family, verb, ...(target ? { target } : {}) }
}

function toolTarget(args: unknown): string | undefined {
  if (typeof args === 'string') return oneLine(args)
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of TARGET_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return key === 'path' && /^\.\/?$/.test(value.trim()) ? 'workspace root' : oneLine(value)
  }
  return undefined
}

function oneLine(value: string): string {
  const line = value.trim().split(/\r?\n/)[0] ?? ''
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Tool'
}

function isEntry(value: unknown): value is { path: string; type?: string } {
  return Boolean(value) && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string'
}

/**
 * Tools often return `{ stdout, stderr, exitCode }`-like records or JSON
 * strings. Pull out the text a human wants to read first.
 */
export function readableOutput(output: unknown): { text: string; language?: string } {
  if (output === undefined || output === null) return { text: '' }
  if (typeof output === 'string') {
    const trimmed = output.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return readableOutput(JSON.parse(trimmed) as unknown)
      } catch {
        // Not JSON after all.
      }
    }
    return { text: output }
  }
  if (typeof output === 'object' && !Array.isArray(output)) {
    const record = output as Record<string, unknown>
    const stdout = typeof record.stdout === 'string' ? record.stdout : undefined
    const stderr = typeof record.stderr === 'string' ? record.stderr : undefined
    if (stdout !== undefined || stderr !== undefined) {
      const parts = [stdout?.trimEnd(), stderr?.trimEnd()].filter((part): part is string => Boolean(part))
      const exit = typeof record.exitCode === 'number' ? record.exitCode : typeof record.code === 'number' ? record.code : undefined
      if (exit !== undefined && exit !== 0) parts.push(`exit code ${exit}`)
      return { text: parts.join('\n') }
    }
    if (typeof record.content === 'string') {
      return { text: record.truncated === true ? `${record.content}\n… (truncated)` : record.content }
    }
  }
  // Directory listings: `[{ name, path, type }]`.
  if (Array.isArray(output) && output.length > 0 && output.every(isEntry)) {
    return { text: output.map(entry => `${entry.type === 'directory' ? '▸ ' : '  '}${entry.path}${entry.type === 'directory' ? '/' : ''}`).join('\n') }
  }
  return { text: JSON.stringify(output, null, 2), language: 'json' }
}

/** Keep each text() emission separate and display a returned value on its own. */
export function codeModeOutput(output: unknown): { blocks: string[]; value?: unknown } {
  if (output && typeof output === 'object' && 'output' in output && Array.isArray(output.output)
    && output.output.every((item: unknown): item is string => typeof item === 'string')) {
    return { blocks: output.output, ...('value' in output ? { value: output.value } : {}) }
  }
  const readable = readableOutput(output)
  return { blocks: readable.text ? [readable.text] : [] }
}

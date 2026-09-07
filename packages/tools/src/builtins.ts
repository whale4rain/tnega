import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { Context } from '@tnega/core'
import type {
  ToolDefinition,
  ToolExecuteOptions,
  ToolExecutor,
  ToolParameterSchema,
  ToolSchema,
  ToolsService,
} from './index.js'
import { evaluateExpression } from './calc.js'
import { localExecutionProvider, type ExecutionProvider } from './execution.js'
import { resolveInside } from './path.js'

export interface BuiltinToolsConfig {
  cwd?: string
  allowNetwork?: boolean
  allowShell?: boolean
  disabled?: readonly string[]
  maxReadBytes?: number
  maxWriteBytes?: number
  maxSearchBytes?: number
  maxResults?: number
  timeoutMs?: number
  execution?: ExecutionProvider
}

interface NormalizedBuiltinToolsConfig {
  cwd: string
  allowNetwork: boolean
  allowShell: boolean
  disabled: readonly string[]
  maxReadBytes: number
  maxWriteBytes: number
  maxSearchBytes: number
  maxResults: number
  timeoutMs: number
  execution: ExecutionProvider
}

export class ToolInputError extends Error {
  override name = 'ToolInputError'
}

const DEFAULT_TOOL_NAMES = [
  'echo',
  'now',
  'calculator',
  'json',
  'read_file',
  'write_file',
  'list_dir',
  'glob',
  'grep',
] as const

function normalizeConfig(config: BuiltinToolsConfig = {}): NormalizedBuiltinToolsConfig {
  return {
    cwd: config.cwd ?? process.cwd(),
    allowNetwork: config.allowNetwork ?? false,
    allowShell: config.allowShell ?? false,
    disabled: [...(config.disabled ?? [])],
    maxReadBytes: config.maxReadBytes ?? 256 * 1024,
    maxWriteBytes: config.maxWriteBytes ?? 1024 * 1024,
    maxSearchBytes: config.maxSearchBytes ?? 1024 * 1024,
    maxResults: config.maxResults ?? 200,
    timeoutMs: config.timeoutMs ?? 15_000,
    execution: config.execution ?? localExecutionProvider,
  }
}

function definition(
  name: string,
  description: string,
  execute: ToolExecutor,
  parameters?: ToolParameterSchema,
): ToolDefinition {
  const schema: ToolSchema = { name, description }
  if (parameters) schema.parameters = parameters
  return { schema, execute }
}

function record(value: unknown, label = 'input'): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new ToolInputError(`${label} must be an object`)
}

function stringField(value: unknown, name: string): string {
  if (typeof value === 'string') return value
  throw new ToolInputError(`${name} must be a string`)
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return stringField(value, name)
}

function numberField(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new ToolInputError(`${name} must be a finite number`)
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  return numberField(value, name)
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') return value
  throw new ToolInputError(`${name} must be a boolean`)
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  return booleanField(value, name)
}

function optionalRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const source = record(value, name)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== 'string') throw new ToolInputError(`${name}.${key} must be a string`)
    result[key] = entry
  }
  return result
}

function displayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target)
  return (rel === '' ? '.' : rel).split(sep).join('/')
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function echoTool(): ToolDefinition {
  return definition(
    'echo',
    'Return the input text unchanged. Useful for quick checks and debugging.',
    (input) => stringField(record(input).text, 'text'),
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'text to return' },
      },
      required: ['text'],
    },
  )
}

function nowTool(): ToolDefinition {
  return definition(
    'now',
    'Return the current date and time as an ISO 8601 string in the local timezone.',
    () => new Date().toISOString(),
    { type: 'object', properties: {} },
  )
}

function calculatorTool(): ToolDefinition {
  return definition(
    'calculator',
    'Evaluate a safe arithmetic expression and return the numeric result. Supports + - * / % ^, parentheses, constants pi/e/tau and functions abs/round/floor/ceil/sqrt/pow/min/max/log/ln.',
    (input) => evaluateExpression(stringField(record(input).expression, 'expression')),
    {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'arithmetic expression, e.g. "(2 + 3) * 4"',
        },
      },
      required: ['expression'],
    },
  )
}

function jsonTool(): ToolDefinition {
  return definition(
    'json',
    'Parse a JSON string, stringify a value, or get a value by path. Operations: parse (value is a JSON string), stringify (value is any JSON value), get (value is a JSON value, path uses dot and bracket notation like a.b[0].c).',
    (input) => {
      const args = record(input)
      const operation = optionalString(args.operation, 'operation') ?? 'parse'
      if (operation === 'stringify') {
        const space = optionalNumber(args.space, 'space')
        try {
          return JSON.stringify(args.value, null, space)
        } catch (error) {
          throw new ToolInputError(`cannot stringify value: ${message(error)}`)
        }
      }
      if (operation === 'get') {
        return jsonGet(args.value, stringField(args.path, 'path'))
      }
      if (operation !== 'parse') {
        throw new ToolInputError(`unknown json operation: ${operation}`)
      }
      const text = stringField(args.value, 'value')
      try {
        return JSON.parse(text) as unknown
      } catch (error) {
        throw new ToolInputError(`invalid JSON: ${message(error)}`)
      }
    },
    {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['parse', 'stringify', 'get'],
          description: 'operation to perform',
        },
        value: {
          description: 'input value for the operation',
        },
        path: {
          type: 'string',
          description: 'path to get, e.g. "a.b[0]"',
        },
        space: {
          type: 'number',
          description: 'indentation for stringify',
        },
      },
      required: ['operation'],
    },
  )
}

function jsonGet(value: unknown, path: string): unknown {
  const segments = parseJsonPath(path)
  let current: unknown = value
  for (const segment of segments) {
    if (current == null || (typeof current !== 'object' && typeof current !== 'string')) {
      throw new ToolInputError(`json path not found: ${path}`)
    }
    if (Array.isArray(current)) {
      current = current[Number(segment)]
    } else if (typeof current === 'string') {
      current = Number.isInteger(Number(segment)) ? current[Number(segment)] : undefined
    } else {
      current = (current as Record<string, unknown>)[segment]
    }
    if (current === undefined) throw new ToolInputError(`json path not found: ${path}`)
  }
  return current
}

function parseJsonPath(path: string): string[] {
  let text = path.trim()
  if (!text) throw new ToolInputError('json path must be a non-empty string')
  if (text.startsWith('$')) text = text.slice(1)
  if (text.startsWith('.')) text = text.slice(1)

  const segments: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '.') {
      index += 1
      continue
    }
    if (char === '[') {
      const close = text.indexOf(']', index + 1)
      if (close < 0) throw new ToolInputError(`invalid json path: ${path}`)
      const inner = text.slice(index + 1, close).trim()
      if (!inner) throw new ToolInputError(`invalid json path: ${path}`)
      segments.push(stripQuotes(inner))
      index = close + 1
      continue
    }
    const dot = text.indexOf('.', index)
    const bracket = text.indexOf('[', index)
    const end = Math.min(
      text.length,
      ...(dot >= 0 ? [dot] : []),
      ...(bracket >= 0 ? [bracket] : []),
    )
    const segment = text.slice(index, end).trim()
    if (!segment) throw new ToolInputError(`invalid json path: ${path}`)
    segments.push(segment)
    index = end
  }
  return segments
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function readFileTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'read_file',
    'Read a UTF-8 text file inside the workspace. Returns { path, bytes, content }.',
    async (input) => {
      const args = record(input)
      const target = await resolveInside(config.cwd, stringField(args.path, 'path'))
      const stats = await stat(target)
      if (stats.isDirectory()) throw new ToolInputError(`not a file: ${args.path}`)
      const maxBytes = optionalNumber(args.maxBytes, 'maxBytes') ?? config.maxReadBytes
      if (stats.size > maxBytes) {
        throw new ToolInputError(`file exceeds ${maxBytes} bytes: ${args.path}`)
      }
      const buffer = await readFile(target)
      if (buffer.includes(0)) throw new ToolInputError(`file is binary: ${args.path}`)
      return {
        path: displayPath(config.cwd, target),
        bytes: buffer.byteLength,
        content: buffer.toString('utf8'),
      }
    },
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace' },
        maxBytes: { type: 'number', description: 'optional byte limit' },
      },
      required: ['path'],
    },
  )
}

function writeFileTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'write_file',
    'Write UTF-8 text to a file inside the workspace, creating parent directories as needed. Returns { path, bytes, appended }.',
    async (input) => {
      const args = record(input)
      const target = await resolveInside(config.cwd, stringField(args.path, 'path'))
      const content = stringField(args.content, 'content')
      const append = optionalBoolean(args.append, 'append') ?? false
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > config.maxWriteBytes) {
        throw new ToolInputError(`content exceeds ${config.maxWriteBytes} bytes`)
      }
      await mkdir(dirname(target), { recursive: true })
      if (append) {
        await appendFile(target, content, 'utf8')
      } else {
        await writeFile(target, content, 'utf8')
      }
      return {
        path: displayPath(config.cwd, target),
        bytes,
        appended: append,
      }
    },
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace' },
        content: { type: 'string', description: 'text content to write' },
        append: { type: 'boolean', description: 'append instead of overwrite' },
      },
      required: ['path', 'content'],
    },
  )
}

interface DirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

function toEntry(cwd: string, dir: string, entry: { name: string; isDirectory(): boolean }): DirectoryEntry {
  return {
    name: entry.name,
    path: displayPath(cwd, join(dir, entry.name)),
    type: entry.isDirectory() ? 'directory' : 'file',
  }
}

async function collectEntries(
  cwd: string,
  root: string,
  dir: string,
  max: number,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = []
  const children = await readdir(dir, { withFileTypes: true })
  for (const entry of children) {
    if (entries.length >= max) break
    entries.push(toEntry(cwd, dir, entry))
    if (entry.isDirectory()) {
      entries.push(...await collectEntries(cwd, root, join(dir, entry.name), max))
    }
  }
  return entries
}

function listDirTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'list_dir',
    'List directory entries inside the workspace. Returns [{ name, path, type }].',
    async (input) => {
      const args = record(input)
      const base = await resolveInside(config.cwd, optionalString(args.path, 'path') ?? '.')
      const stats = await stat(base)
      if (!stats.isDirectory()) throw new ToolInputError(`not a directory: ${args.path ?? '.'}`)
      const recursive = optionalBoolean(args.recursive, 'recursive') ?? false
      const entries = recursive
        ? await collectEntries(config.cwd, base, base, config.maxResults)
        : (await readdir(base, { withFileTypes: true }))
          .map(entry => toEntry(config.cwd, base, entry))
      return entries.slice(0, config.maxResults)
    },
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'directory path relative to the workspace' },
        recursive: { type: 'boolean', description: 'include nested entries' },
      },
    },
  )
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll('\\', '/').replace(/^\.\//, '')
}

function globToRegExp(pattern: string): RegExp {
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 2
        if (pattern[index] === '/') {
          source += '/?'
          index += 1
        }
      } else {
        source += '[^/]*'
        index += 1
      }
    } else if (char === '?') {
      source += '[^/]'
      index += 1
    } else {
      source += char.replace(/[\\^$+?.()|{}[\]]/g, '\\$&')
      index += 1
    }
  }
  return new RegExp(`^${source}$`)
}

async function walkFiles(
  cwd: string,
  root: string,
  dir: string,
  regex: RegExp,
  matches: string[],
  max: number,
): Promise<void> {
  if (matches.length >= max) return
  const children = await readdir(dir, { withFileTypes: true })
  for (const entry of children) {
    if (matches.length >= max) return
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(cwd, root, target, regex, matches, max)
    } else if (entry.isFile()) {
      const rel = relative(root, target).split(sep).join('/')
      if (regex.test(rel)) matches.push(displayPath(cwd, target))
    }
  }
}

function globTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'glob',
    'Find files by glob pattern inside the workspace. Supports ** (any depth), * (within a segment) and ? (single character). Returns relative paths.',
    async (input) => {
      const args = record(input)
      const pattern = normalizeGlobPattern(stringField(args.pattern, 'pattern'))
      const root = await resolveInside(config.cwd, optionalString(args.base, 'base') ?? '.')
      const regex = globToRegExp(pattern)
      const matches: string[] = []
      await walkFiles(config.cwd, root, root, regex, matches, config.maxResults)
      return matches.slice(0, config.maxResults)
    },
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob pattern, e.g. "**/*.ts"' },
        base: { type: 'string', description: 'directory to search, defaults to workspace root' },
      },
      required: ['pattern'],
    },
  )
}

interface GrepMatch {
  file: string
  line: number
  text: string
}

async function grepWalk(
  config: NormalizedBuiltinToolsConfig,
  root: string,
  dir: string,
  regex: RegExp,
  globRegex: RegExp | undefined,
  matches: GrepMatch[],
  max: number,
): Promise<void> {
  if (matches.length >= max) return
  const children = await readdir(dir, { withFileTypes: true })
  for (const entry of children) {
    if (matches.length >= max) return
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await grepWalk(config, root, target, regex, globRegex, matches, max)
      continue
    }
    if (!entry.isFile()) continue
    const rel = relative(root, target).split(sep).join('/')
    if (globRegex && !globRegex.test(rel)) continue
    const stats = await stat(target)
    if (stats.size > config.maxSearchBytes) continue
    const buffer = await readFile(target)
    if (buffer.includes(0)) continue
    const lines = buffer.toString('utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= max) return
      const line = lines[index]!
      if (regex.test(line)) {
        matches.push({
          file: displayPath(config.cwd, target),
          line: index + 1,
          text: line,
        })
      }
    }
  }
}

function grepTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'grep',
    'Search text files for a regular expression. Returns [{ file, line, text }].',
    async (input) => {
      const args = record(input)
      const pattern = stringField(args.pattern, 'pattern')
      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (error) {
        throw new ToolInputError(`invalid regular expression: ${message(error)}`)
      }
      const root = await resolveInside(config.cwd, optionalString(args.path, 'path') ?? '.')
      const globPattern = optionalString(args.glob, 'glob')
      const globRegex = globPattern ? globToRegExp(normalizeGlobPattern(globPattern)) : undefined
      const max = optionalNumber(args.maxResults, 'maxResults') ?? config.maxResults
      const matches: GrepMatch[] = []
      await grepWalk(config, root, root, regex, globRegex, matches, max)
      return matches
    },
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression to search for' },
        path: { type: 'string', description: 'directory to search, defaults to workspace root' },
        glob: { type: 'string', description: 'optional file glob filter, e.g. "**/*.md"' },
        maxResults: { type: 'number', description: 'optional result limit' },
      },
      required: ['pattern'],
    },
  )
}

function httpGetTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'http_get',
    'Fetch a URL over HTTP(S) and return { status, ok, headers, body, truncated }.',
    async (input, options: ToolExecuteOptions) => {
      const args = record(input)
      const rawUrl = stringField(args.url, 'url')
      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        throw new ToolInputError(`invalid URL: ${rawUrl}`)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ToolInputError(`unsupported protocol: ${url.protocol}`)
      }
      const headers = optionalRecord(args.headers, 'headers') ?? {}
      const maxBytes = optionalNumber(args.maxBytes, 'maxBytes') ?? config.maxReadBytes
      return config.execution.fetchHttp({
        url: url.href,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(maxBytes !== config.maxReadBytes ? { maxBytes } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    },
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http or https URL' },
        headers: {
          type: 'object',
          description: 'optional request headers',
        },
        maxBytes: { type: 'number', description: 'optional response body byte limit' },
      },
      required: ['url'],
    },
  )
}

function shellTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'shell',
    'Run a shell command inside the workspace and return { exitCode, stdout, stderr }. Disabled by default; enable with allowShell.',
    async (input, options: ToolExecuteOptions) => {
      const args = record(input)
      const command = stringField(args.command, 'command')
      const cwd = await resolveInside(config.cwd, optionalString(args.cwd, 'cwd') ?? '.')
      const timeoutMs = optionalNumber(args.timeoutMs, 'timeoutMs') ?? config.timeoutMs
      const result = await config.execution.runShell({
        command,
        cwd,
        timeoutMs,
        maxBuffer: config.maxWriteBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'shell command to run' },
        cwd: { type: 'string', description: 'working directory relative to the workspace' },
        timeoutMs: { type: 'number', description: 'optional timeout in milliseconds' },
      },
      required: ['command'],
    },
  )
}

export function createBuiltinToolDefinitions(
  config: BuiltinToolsConfig = {},
): ToolDefinition[] {
  const normalized = normalizeConfig(config)
  const disabled = new Set(normalized.disabled)
  const definitions: ToolDefinition[] = []
  if (!disabled.has('echo')) definitions.push(echoTool())
  if (!disabled.has('now')) definitions.push(nowTool())
  if (!disabled.has('calculator')) definitions.push(calculatorTool())
  if (!disabled.has('json')) definitions.push(jsonTool())
  if (!disabled.has('read_file')) definitions.push(readFileTool(normalized))
  if (!disabled.has('write_file')) definitions.push(writeFileTool(normalized))
  if (!disabled.has('list_dir')) definitions.push(listDirTool(normalized))
  if (!disabled.has('glob')) definitions.push(globTool(normalized))
  if (!disabled.has('grep')) definitions.push(grepTool(normalized))
  if (normalized.allowNetwork && !disabled.has('http_get')) {
    definitions.push(httpGetTool(normalized))
  }
  if (normalized.allowShell && !disabled.has('shell')) {
    definitions.push(shellTool(normalized))
  }
  return definitions
}

export const builtinTools = {
  name: 'builtinTools',
  inject: ['tools'],
  apply(ctx: Context, config: BuiltinToolsConfig = {}) {
    const service = ctx.get('tools') as ToolsService
    for (const definition of createBuiltinToolDefinitions(config)) {
      service.register(definition)
    }
  },
}

export const DEFAULT_BUILTIN_TOOL_NAMES: readonly string[] = DEFAULT_TOOL_NAMES

import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { Context } from '@tnega/core'
import type {
  ToolDefinition,
  ToolExecuteOptions,
  ToolExecutor,
  ToolParameterSchema,
  ToolSchema,
} from './index.js'
import { ToolInputError } from './errors.js'
import {
  message,
  optionalBoolean,
  optionalNumber,
  optionalRecord,
  optionalString,
  record,
  stringField,
} from './input.js'
import { evaluateExpression } from './calc.js'
import { createFileTools, type FsGuardMode } from './fs/index.js'
import { ToolAbortError } from './errors.js'
import { resolveInside } from './path.js'
import { ESCALATE_HINT, ESCALATE_PROPERTIES, escalated } from './escalation.js'
import { ProcessRegistry, type ProcessEntry } from './processes.js'
import { DEFAULT_SEARCH_EXCLUDES } from '@tnega/search'
import {
  describeShell,
  localExecutionProvider,
  systemShell,
  type ExecutionProvider,
} from '@tnega/execution'

export interface BuiltinToolsConfig {
  cwd?: string
  allowNetwork?: boolean
  allowShell?: boolean
  allowOutsideWorkspace?: boolean | (() => boolean | Promise<boolean>)
  allowPrivateNetwork?: boolean | (() => boolean | Promise<boolean>)
  disabled?: readonly string[]
  maxReadBytes?: number
  maxWriteBytes?: number
  /** Lines one read returns unless it asks for fewer; also the most it may ask for. */
  maxReadLines?: number
  /** Characters kept per line before the line is clipped. */
  maxLineChars?: number
  /**
   * Declare `shell`'s `runInBackground` parameter. The jobs plugin honours it;
   * without that plugin the flag is refused rather than silently run inline.
   * Defaults to on when this config can start processes at all.
   */
  backgroundJobs?: boolean
  /**
   * How strictly a write must match what this Agent already read of that path.
   * `warn` (default) records and proceeds with a note, `enforce` refuses an
   * unread or externally changed target, `off` does neither.
   */
  fsGuard?: FsGuardMode
  maxResults?: number
  timeoutMs?: number
  /** 递归 `list_dir` 剪掉的目录名；默认与搜索能力的能力级默认值一致。 */
  searchExcludes?: readonly string[]
  execution?: ExecutionProvider
  /** Background processes shared beyond this plugin (see ProcessRegistry). */
  processes?: ProcessRegistry
}

interface NormalizedBuiltinToolsConfig {
  cwd: string
  allowNetwork: boolean
  allowShell: boolean
  allowOutsideWorkspace: boolean | (() => boolean | Promise<boolean>)
  allowPrivateNetwork: boolean | (() => boolean | Promise<boolean>)
  disabled: readonly string[]
  maxReadBytes: number
  maxWriteBytes: number
  maxReadLines: number
  maxLineChars: number
  fsGuard: FsGuardMode
  backgroundJobs: boolean
  maxResults: number
  timeoutMs: number
  searchExcludeSet: ReadonlySet<string>
  execution: ExecutionProvider
  /** Where `shell` run as a background job keeps its process; none means it cannot. */
  processes?: ProcessRegistry
  sharedProcesses: boolean
}

/**
 * Execute option the jobs plugin passes to `shell` when the call asked for
 * `runInBackground`: instead of waiting for the command to exit, the tool starts it
 * as a background process in the workspace registry and hands the entry over.
 * Tools that accept it declare `metadata.backgroundProcess: true`.
 */
export const ADOPT_BACKGROUND_PROCESS = 'adoptBackgroundProcess'

export interface AdoptedProcess {
  entry: ProcessEntry
  /** True when the registry outlives this runtime (the web server's per-workspace one). */
  shared: boolean
  /** Stop the process tree through the registry, so it reads as stopped rather than failed. */
  stop(): Promise<void>
}

export type AdoptBackgroundProcess = (process: AdoptedProcess) => void

export { ToolInputError } from './errors.js'

const DEFAULT_TOOL_NAMES = [
  'echo',
  'now',
  'calculator',
  'json',
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
] as const

function normalizeConfig(config: BuiltinToolsConfig = {}, ownedProcesses?: ProcessRegistry): NormalizedBuiltinToolsConfig {
  const processes = config.processes ?? ownedProcesses
  return {
    cwd: config.cwd ?? process.cwd(),
    allowNetwork: config.allowNetwork ?? false,
    allowShell: config.allowShell ?? false,
    allowOutsideWorkspace: config.allowOutsideWorkspace ?? false,
    allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    disabled: [...(config.disabled ?? [])],
    maxReadBytes: config.maxReadBytes ?? 256 * 1024,
    maxWriteBytes: config.maxWriteBytes ?? 1024 * 1024,
    maxReadLines: config.maxReadLines ?? 2000,
    maxLineChars: config.maxLineChars ?? 2000,
    fsGuard: config.fsGuard ?? 'warn',
    backgroundJobs: config.backgroundJobs
      ?? Boolean((config.processes ?? ownedProcesses) && (config.execution ?? localExecutionProvider).startShell),
    maxResults: config.maxResults ?? 200,
    timeoutMs: config.timeoutMs ?? 15_000,
    searchExcludeSet: new Set(config.searchExcludes ?? DEFAULT_SEARCH_EXCLUDES),
    execution: config.execution ?? localExecutionProvider,
    ...(processes ? { processes } : {}),
    sharedProcesses: config.processes !== undefined,
  }
}

async function enabled(value: boolean | (() => boolean | Promise<boolean>)): Promise<boolean> {
  return typeof value === 'function' ? value() : value
}

async function resolveToolPath(config: NormalizedBuiltinToolsConfig, path: string): Promise<string> {
  return await enabled(config.allowOutsideWorkspace)
    ? Promise.resolve(resolve(config.cwd, path))
    : resolveInside(config.cwd, path)
}

function definition(
  name: string,
  description: string,
  execute: ToolExecutor,
  parameters?: ToolParameterSchema,
  timeoutMs?: number,
): ToolDefinition {
  const schema: ToolSchema = { name, description }
  if (parameters) schema.parameters = parameters
  const tool: ToolDefinition = { schema, execute }
  if (timeoutMs !== undefined) tool.timeoutMs = timeoutMs
  return tool
}

function displayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target)
  return (rel === '' ? '.' : rel).split(sep).join('/')
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
    'Parse a JSON string, stringify a value, or get a value by path. Operations: parse (value is a JSON string), stringify (value is any JSON value), get (value is a JSON value, path uses dot and bracket notation like a.b[0].c). Returns directly: stringify returns a string, parse returns the parsed value, get returns the selected value; none adds a { value } wrapper.',
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
  excludes: ReadonlySet<string>,
  dir: string,
  max: number,
  signal?: AbortSignal,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = []
  const children = await readdir(dir, { withFileTypes: true })
  for (const entry of children) {
    if (entries.length >= max) break
    if (signal?.aborted) throw new ToolAbortError()
    const isDirectory = entry.isDirectory()
    if (isDirectory && excludes.has(entry.name)) continue
    entries.push(toEntry(cwd, dir, entry))
    if (isDirectory) {
      entries.push(...await collectEntries(cwd, excludes, join(dir, entry.name), max, signal))
    }
  }
  return entries
}

function listDirTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  return definition(
    'list_dir',
    'List directory entries inside the workspace. Returns [{ name, path, type }], where type is "directory" or "file"; directories use "directory", not "dir".',
    async (input, options: ToolExecuteOptions) => {
      const args = record(input)
      const base = await resolveToolPath(config, optionalString(args.path, 'path') ?? '.')
      const stats = await stat(base)
      if (!stats.isDirectory()) throw new ToolInputError(`not a directory: ${args.path ?? '.'}`)
      const recursive = optionalBoolean(args.recursive, 'recursive') ?? false
      const entries = recursive
        ? await collectEntries(
            config.cwd,
            config.searchExcludeSet,
            base,
            config.maxResults,
            options.signal,
          )
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
        ...(await enabled(config.allowPrivateNetwork) ? { allowPrivate: true } : {}),
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

/** Decode each stream incrementally, so a character split across chunks arrives whole. */
function progressDecoder(progress: (output: string) => void): (chunk: Buffer, stream: 'stdout' | 'stderr') => void {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
  return (chunk, stream) => {
    const text = decoders[stream].decode(chunk, { stream: true })
    if (text) progress(text)
  }
}

/** Where a long command belongs: a timeout expires, it does not background. */
const BACKGROUND_HINT = 'Long commands (downloads, installs, builds, full test suites) need a larger timeoutMs; on expiry the command is killed, not backgrounded.'

function shellTool(config: NormalizedBuiltinToolsConfig): ToolDefinition {
  const properties: Record<string, unknown> = {
    command: { type: 'string', description: 'shell command to run' },
    cwd: { type: 'string', description: 'working directory relative to the workspace' },
    timeoutMs: { type: 'number', description: 'optional timeout in milliseconds' },
  }
  if (config.backgroundJobs) {
    // Declared here, honoured by the jobs plugin: the tool owns the schema, the
    // job registry owns the work, and neither package depends on the other.
    properties.runInBackground = {
      type: 'boolean',
      description: 'run it as a background job and return a job id immediately (no timeout applies); read it with job_output',
    }
    properties.waitForUrlMs = {
      type: 'number',
      description: 'with runInBackground: wait this long for the command to print a local URL before answering',
    }
  }
  return definition(
    'shell',
    `Run a shell command inside the workspace and return { exitCode, stdout, stderr }. ${describeShell(systemShell())} ${BACKGROUND_HINT} ${ESCALATE_HINT}`,
    async (input, options: ToolExecuteOptions) => {
      const args = record(input)
      const command = stringField(args.command, 'command')
      const cwd = await resolveToolPath(config, optionalString(args.cwd, 'cwd') ?? '.')
      const adopt = options[ADOPT_BACKGROUND_PROCESS]
      if (args.runInBackground === true && typeof adopt !== 'function') {
        throw new Error('this runtime cannot run background commands; run it in the foreground with a larger timeoutMs')
      }
      if (typeof adopt === 'function') {
        const start = config.execution.startShell?.bind(config.execution)
        const registry = config.processes
        if (!start || !registry) throw new Error('this host cannot run background processes; run the command with shell and a timeout instead')
        const running = registry.running()
        if (running.length >= registry.maxProcesses) {
          throw new Error(`already running ${running.length} background processes (${running.map(entry => entry.command).join('; ')}); stop one with job_kill first`)
        }
        const process = await start({ command, cwd, ...(escalated(args, options) ? { unsandboxed: true } : {}) })
        const entry = registry.add(command, cwd, process)
        ;(adopt as AdoptBackgroundProcess)({ entry, shared: config.sharedProcesses, stop: async () => { await registry.stop(entry.id) } })
        return { processId: entry.id, status: 'running', ...(process.pid !== undefined ? { pid: process.pid } : {}) }
      }
      const timeoutMs = optionalNumber(args.timeoutMs, 'timeoutMs') ?? config.timeoutMs
      const result = await config.execution.runShell({
        command,
        cwd,
        timeoutMs,
        maxBuffer: config.maxWriteBytes,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.progress ? { onOutput: progressDecoder(options.progress) } : {}),
        ...(escalated(args, options) ? { unsandboxed: true } : {}),
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },
    {
      type: 'object',
      properties: { ...properties, ...ESCALATE_PROPERTIES },
      required: ['command'],
    },
  )
}

export function createBuiltinToolDefinitions(
  config: BuiltinToolsConfig = {},
  /** A registry the caller owns and disposes, used when `config.processes` is absent. */
  ownedProcesses?: ProcessRegistry,
): ToolDefinition[] {
  const normalized = normalizeConfig(config, ownedProcesses)
  const disabled = new Set(normalized.disabled)
  const definitions: ToolDefinition[] = []
  if (!disabled.has('echo')) definitions.push(echoTool())
  if (!disabled.has('now')) definitions.push(nowTool())
  if (!disabled.has('calculator')) definitions.push(calculatorTool())
  if (!disabled.has('json')) definitions.push(jsonTool())
  for (const tool of createFileTools({
    resolve: async path => await resolveToolPath(normalized, path),
    displayPath: target => displayPath(normalized.cwd, target),
    maxReadBytes: normalized.maxReadBytes,
    maxWriteBytes: normalized.maxWriteBytes,
    maxReadLines: normalized.maxReadLines,
    maxLineChars: normalized.maxLineChars,
    fsGuard: normalized.fsGuard,
  })) {
    if (!disabled.has(tool.schema.name)) definitions.push(tool)
  }
  if (!disabled.has('list_dir')) {
    const listDir = listDirTool(normalized)
    // A directory listing reads; nothing it does is observable by a sibling.
    listDir.isConcurrencySafe = () => true
    definitions.push(listDir)
  }
  if (normalized.allowNetwork && !disabled.has('http_get')) {
    const httpGet = httpGetTool(normalized)
    // A GET has no effect of its own; two of them cannot disturb each other.
    httpGet.isConcurrencySafe = () => true
    definitions.push(httpGet)
  }
  if (normalized.allowShell && !disabled.has('shell')) {
    const shell = shellTool(normalized)
    // The jobs plugin turns `runInBackground` into a job (a dev server, a watcher).
    if (normalized.backgroundJobs) shell.metadata = { ...shell.metadata, backgroundProcess: true }
    definitions.push(shell)
  }
  for (const definition of definitions) {
    definition.interruption ??= BUILTIN_INTERRUPTION[definition.schema.name] ?? 'fail'
  }
  return definitions
}

/**
 * What a call cut off by a restart may do next. Read-only tools may simply run
 * again; tools whose effect may already have happened ask for confirmation.
 */
const BUILTIN_INTERRUPTION: Readonly<Record<string, 'retry' | 'confirm'>> = {
  echo: 'retry',
  now: 'retry',
  calculator: 'retry',
  json: 'retry',
  read_file: 'retry',
  edit_file: 'confirm',
  list_dir: 'retry',
  http_get: 'retry',
  write_file: 'confirm',
  shell: 'confirm',
}

export const builtinTools = {
  name: 'builtinTools',
  inject: ['tools'],
  apply(ctx: Context, config: BuiltinToolsConfig = {}) {
    const service = ctx.tools
    // Without a shared registry, background processes die with this plugin.
    const owned = config.processes || !config.allowShell ? undefined : new ProcessRegistry()
    if (owned) ctx.fiber.effect(() => () => { void owned.dispose() }, 'builtinTools/processes')
    const definitions = createBuiltinToolDefinitions(config, owned)
    for (const definition of definitions) {
      service.register(definition)
    }
  },
}

export const DEFAULT_BUILTIN_TOOL_NAMES: readonly string[] = DEFAULT_TOOL_NAMES

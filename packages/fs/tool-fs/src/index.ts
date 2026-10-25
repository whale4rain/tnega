import { relative, resolve, sep } from 'node:path'
import type { Context } from '@tnega/core'
import { DEFAULT_SEARCH_EXCLUDES } from '@tnega/search'
import { resolveInside, type ToolDefinition } from '@tnega/tools'
import { editFileTool } from './edit.js'
import { listDirTool } from './list.js'
import { ObservationStore } from './observed.js'
import { readFileTool } from './read.js'
import type { FileToolsConfig, FsGuardMode } from './types.js'
import { writeFileTool } from './write.js'

export { editFileTool, listDirTool, readFileTool, writeFileTool }
export { ObservationStore, fingerprint, type Observation } from './observed.js'
export { writeFileAtomic } from './atomic.js'
export type { FileToolsConfig, FsGuardMode } from './types.js'
export type { ListDirConfig } from './list.js'

/** The model-visible file tools of this package, in the order the model sees them. */
export const TOOL_FS_NAMES: readonly string[] = ['read_file', 'write_file', 'edit_file', 'list_dir']

/** `read_file` / `write_file` / `edit_file` / `list_dir` for one workspace. */
export interface ToolFsConfig {
  /** Workspace root; every path is resolved against it and fenced inside it. */
  cwd?: string
  /** Let paths leave the workspace (the `bypass` permission). */
  allowOutsideWorkspace?: boolean | (() => boolean | Promise<boolean>)
  /** Tool names to leave out. */
  disabled?: readonly string[]
  /** Byte cap for one `read_file` result (it is exempt from spill). */
  maxReadBytes?: number
  /** Byte cap for one write or edited file. */
  maxWriteBytes?: number
  /** Lines one read returns unless it asks for fewer; also the most it may ask for. */
  maxReadLines?: number
  /** Characters a long line keeps when a page has to be cut to fit. */
  maxLineChars?: number
  /** How strictly a write must match what this Agent already read of that path. */
  fsGuard?: FsGuardMode
  /** Most entries one `list_dir` returns. */
  maxResults?: number
  /** Directory names a recursive `list_dir` skips; defaults to the search seam's. */
  searchExcludes?: readonly string[]
  /** Where reads are recorded; defaults to a store owned by these tools. */
  observations?: ObservationStore
}

async function enabled(value: boolean | (() => boolean | Promise<boolean>)): Promise<boolean> {
  return typeof value === 'function' ? await value() : value
}

/** Build the file tools of one scope without registering them. */
export function createFsTools(config: ToolFsConfig = {}): ToolDefinition[] {
  const cwd = config.cwd ?? process.cwd()
  const outside = config.allowOutsideWorkspace ?? false
  const resolvePath = async (path: string): Promise<string> => await enabled(outside)
    ? resolve(cwd, path)
    : await resolveInside(cwd, path)
  const displayPath = (target: string): string => {
    const rel = relative(cwd, target)
    return (rel === '' ? '.' : rel).split(sep).join('/')
  }
  const files: FileToolsConfig = {
    resolve: resolvePath,
    displayPath,
    maxReadBytes: config.maxReadBytes ?? 50 * 1024,
    maxWriteBytes: config.maxWriteBytes ?? 1024 * 1024,
    maxReadLines: config.maxReadLines ?? 2000,
    maxLineChars: config.maxLineChars ?? 2000,
    fsGuard: config.fsGuard ?? 'warn',
    observations: config.observations ?? new ObservationStore(),
  }
  const disabled = new Set(config.disabled ?? [])
  const all = [
    readFileTool(files),
    writeFileTool(files),
    editFileTool(files),
    listDirTool({
      cwd,
      resolve: resolvePath,
      displayPath,
      maxResults: config.maxResults ?? 200,
      excludes: new Set(config.searchExcludes ?? DEFAULT_SEARCH_EXCLUDES),
    }),
  ]
  return all.filter(tool => !disabled.has(tool.schema.name))
}

/**
 * The file domain's model-visible tools: read by line, write and edit
 * atomically, list a directory. Searching (`glob` / `grep`) is the search seam's
 * Consumer next door, `@tnega/tool-search`.
 *
 * Mount: `await ctx.plugin(toolFs, { cwd })`.
 */
export const toolFs = {
  name: 'tool-fs',
  inject: ['tools'],
  apply(ctx: Context, config: ToolFsConfig = {}): void {
    for (const tool of createFsTools(config)) ctx.tools.register(tool)
  },
}

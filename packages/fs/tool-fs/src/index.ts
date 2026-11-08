import type { Context } from '@tnega/core'
import { workspacePath, type WorkspaceFs } from '@tnega/fs'
import { DEFAULT_SEARCH_EXCLUDES } from '@tnega/search'
import type { ToolDefinition } from '@tnega/tools'
import { editFileTool } from './edit.js'
import { listDirTool } from './list.js'
import { sharedObservations, type ObservationStore } from './observed.js'
import { readFileTool } from './read.js'
import type { FileToolsConfig, FsGuardMode } from './types.js'
import { writeFileTool } from './write.js'

export { editFileTool, listDirTool, readFileTool, writeFileTool }
export { ObservationStore, fingerprint, sharedObservations, type Observation } from './observed.js'
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
  /**
   * Where reads are recorded. Defaults to one store for the process, so a
   * runtime rebuilt between turns (a model or permission change, plan mode)
   * still knows what its Agent read.
   */
  observations?: ObservationStore
}

/**
 * Build the file tools of one workspace without registering them. `fs` is the
 * workspace as `ctx.fs` opened it: it resolves paths, fences them (the
 * `bypass` permission is the handle's `allowOutside`) and does every read and
 * write, so the tools work the same on a workspace on another machine.
 */
export function createFsTools(fs: WorkspaceFs, config: Omit<ToolFsConfig, 'cwd' | 'allowOutsideWorkspace'> = {}): ToolDefinition[] {
  const cwd = fs.root
  let root: string | undefined
  const resolvePath = async (path: string): Promise<string> => {
    const target = await fs.resolve(path)
    root ??= await fs.realRoot()
    return target
  }
  // The workspace's own path rules: its files may sit on a machine with another OS.
  const { isAbsolute, relative, sep } = workspacePath(cwd)
  const displayPath = (target: string): string => {
    const fromRoot = root === undefined ? undefined : relative(root, target)
    const rel = fromRoot !== undefined && !fromRoot.startsWith('..') && !isAbsolute(fromRoot) ? fromRoot : relative(cwd, target)
    return (rel === '' ? '.' : rel).split(sep).join('/')
  }
  const files: FileToolsConfig = {
    fs,
    resolve: resolvePath,
    displayPath,
    maxReadBytes: config.maxReadBytes ?? 50 * 1024,
    maxWriteBytes: config.maxWriteBytes ?? 1024 * 1024,
    maxReadLines: config.maxReadLines ?? 2000,
    maxLineChars: config.maxLineChars ?? 2000,
    fsGuard: config.fsGuard ?? 'warn',
    observations: config.observations ?? sharedObservations,
  }
  const disabled = new Set(config.disabled ?? [])
  const all = [
    readFileTool(files),
    writeFileTool(files),
    editFileTool(files),
    listDirTool({
      fs,
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
 * Mount: `await ctx.plugin(toolFs, { cwd })`, after a Provider of `ctx.fs`.
 */
export const toolFs = {
  name: 'tool-fs',
  inject: ['tools', 'fs'],
  apply(ctx: Context, config: ToolFsConfig = {}): void {
    const { cwd, allowOutsideWorkspace, ...rest } = config
    const fs = ctx.fs.workspace(cwd ?? process.cwd(), allowOutsideWorkspace !== undefined ? { allowOutside: allowOutsideWorkspace } : {})
    for (const tool of createFsTools(fs, rest)) ctx.tools.register(tool)
  },
}

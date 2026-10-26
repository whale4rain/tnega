import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@tnega/core'
import { DEFAULT_SEARCH_EXCLUDES } from '@tnega/search'
import { resolveInside, resolveWorkspacePath, switchOn, type ToolDefinition } from '@tnega/tools'
import { editFileTool } from './edit.js'
import { listDirTool } from './list.js'
import { sharedObservations, type ObservationStore } from './observed.js'
import { readFileTool } from './read.js'
import type { FileToolsConfig, FsGuardMode } from './types.js'
import { writeFileTool } from './write.js'

export { editFileTool, listDirTool, readFileTool, writeFileTool }
export { ObservationStore, fingerprint, sharedObservations, type Observation } from './observed.js'
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
  /**
   * Where reads are recorded. Defaults to one store for the process, so a
   * runtime rebuilt between turns (a model or permission change, plan mode)
   * still knows what its Agent read.
   */
  observations?: ObservationStore
}

const MAX_LINK_HOPS = 40

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * The file a path names once every symlink is followed, also for a path that
 * does not exist yet or a link whose target is missing. Locks, read records
 * and the write itself all use this one name, so `link.ts` and `real.ts` are
 * the same file to the guard, and a write never follows a link the fence did
 * not see.
 */
async function canonicalPath(target: string, hops = 0): Promise<string> {
  try {
    return await realpath(target)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const entry = await lstat(target).catch(() => undefined)
  if (entry?.isSymbolicLink()) {
    if (hops >= MAX_LINK_HOPS) throw new Error(`too many symbolic links: ${target}`)
    const to = await readlink(target)
    return await canonicalPath(isAbsolute(to) ? to : resolve(dirname(target), to), hops + 1)
  }
  const parent = dirname(target)
  if (parent === target) return target
  return join(await canonicalPath(parent, hops), basename(target))
}

/** Build the file tools of one scope without registering them. */
export function createFsTools(config: ToolFsConfig = {}): ToolDefinition[] {
  const cwd = config.cwd ?? process.cwd()
  const outside = config.allowOutsideWorkspace ?? false
  let root: string | undefined
  const resolvePath = async (path: string): Promise<string> => {
    const target = await canonicalPath(await resolveWorkspacePath(cwd, outside, path))
    root ??= await realpath(cwd).catch(() => cwd)
    // The followed name is fenced again: a link swapped after the first check
    // must not carry the write outside the workspace.
    return await switchOn(outside) ? target : await resolveInside(root, target)
  }
  const displayPath = (target: string): string => {
    const fromRoot = root === undefined ? undefined : relative(root, target)
    const rel = fromRoot !== undefined && !fromRoot.startsWith('..') && !isAbsolute(fromRoot) ? fromRoot : relative(cwd, target)
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
    observations: config.observations ?? sharedObservations,
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

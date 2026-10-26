import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  optionalBoolean,
  optionalString,
  record,
  ToolAbortError,
  ToolInputError,
  type ToolDefinition,
  type ToolExecuteOptions,
} from '@tnega/tools'

export interface ListDirConfig {
  cwd: string
  resolve(path: string): Promise<string>
  displayPath(target: string): string
  maxResults: number
  /** Directory names a recursive listing skips. */
  excludes: ReadonlySet<string>
}

interface DirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
}

function toEntry(config: ListDirConfig, dir: string, entry: { name: string; isDirectory(): boolean }): DirectoryEntry {
  return {
    name: entry.name,
    path: config.displayPath(join(dir, entry.name)),
    type: entry.isDirectory() ? 'directory' : 'file',
  }
}

async function collectEntries(
  config: ListDirConfig,
  dir: string,
  signal?: AbortSignal,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = []
  const children = await readdir(dir, { withFileTypes: true })
  for (const entry of children) {
    if (entries.length >= config.maxResults) break
    if (signal?.aborted) throw new ToolAbortError()
    const isDirectory = entry.isDirectory()
    if (isDirectory && config.excludes.has(entry.name)) continue
    entries.push(toEntry(config, dir, entry))
    if (isDirectory) entries.push(...await collectEntries(config, join(dir, entry.name), signal))
  }
  return entries
}

export function listDirTool(config: ListDirConfig): ToolDefinition {
  return {
    schema: {
      name: 'list_dir',
      description: 'List directory entries inside the workspace. Returns [{ name, path, type }], where type is "directory" or "file"; directories use "directory", not "dir".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'directory path relative to the workspace' },
          recursive: { type: 'boolean', description: 'include nested entries' },
        },
      },
    },
    interruption: 'retry',
    // A directory listing reads; nothing it does is observable by a sibling.
    isConcurrencySafe: () => true,
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const base = await config.resolve(optionalString(args.path, 'path') ?? '.')
      const stats = await stat(base)
      if (!stats.isDirectory()) throw new ToolInputError(`not a directory: ${String(args.path ?? '.')}`)
      const recursive = optionalBoolean(args.recursive, 'recursive') ?? false
      const entries = recursive
        ? await collectEntries(config, base, options.signal)
        : (await readdir(base, { withFileTypes: true })).map(entry => toEntry(config, base, entry))
      return entries.slice(0, config.maxResults)
    },
  }
}

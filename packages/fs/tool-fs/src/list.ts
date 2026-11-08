import { workspacePath, type FsEntry, type WorkspaceFs } from '@tnega/fs'
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
  fs: WorkspaceFs
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

function toEntry(config: ListDirConfig, dir: string, entry: FsEntry): DirectoryEntry {
  return {
    name: entry.name,
    path: config.displayPath(workspacePath(dir).join(dir, entry.name)),
    type: entry.kind === 'dir' ? 'directory' : 'file',
  }
}

async function collectEntries(
  config: ListDirConfig,
  dir: string,
  signal?: AbortSignal,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = []
  const children = await config.fs.list(dir)
  for (const entry of children) {
    if (entries.length >= config.maxResults) break
    if (signal?.aborted) throw new ToolAbortError()
    const isDirectory = entry.kind === 'dir'
    if (isDirectory && config.excludes.has(entry.name)) continue
    entries.push(toEntry(config, dir, entry))
    if (isDirectory) entries.push(...await collectEntries(config, workspacePath(dir).join(dir, entry.name), signal))
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
      const stats = await config.fs.stat(base)
      if (!stats) throw new ToolInputError(`directory not found: ${String(args.path ?? '.')}`)
      if (stats.kind !== 'dir') throw new ToolInputError(`not a directory: ${String(args.path ?? '.')}`)
      const recursive = optionalBoolean(args.recursive, 'recursive') ?? false
      const entries = recursive
        ? await collectEntries(config, base, options.signal)
        : (await config.fs.list(base)).map(entry => toEntry(config, base, entry))
      return entries.slice(0, config.maxResults)
    },
  }
}

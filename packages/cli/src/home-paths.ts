import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Per-user runtime state; project configuration and user artifacts stay in the workspace. */
export function resolveTnegaHome(): string {
  const configured = process.env.TNEGA_HOME?.trim()
  if (!configured) return join(homedir(), '.tnega')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(homedir(), configured.slice(2))
  return resolve(configured)
}

export function workspaceStorageKey(workspace: string): string {
  const absolute = resolve(workspace)
  const normalized = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  return createHash('sha256').update(normalized).digest('hex')
}

export function workspaceSessionDir(workspace: string): string {
  return join(resolveTnegaHome(), 'sessions', workspaceStorageKey(workspace))
}

export function workspaceStateDir(workspace: string): string {
  return join(resolveTnegaHome(), 'workspaces', workspaceStorageKey(workspace))
}

/** Import once without overwriting a different destination or mutating the legacy backup. */
export function importLegacyFile(source: string, target: string): void {
  const marker = join(dirname(target), '.legacy-imported', workspaceStorageKey(source))
  let sourceInfo: ReturnType<typeof statSync>
  try {
    sourceInfo = statSync(source)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (!sourceInfo.isFile()) return
  const fingerprint = JSON.stringify({ size: sourceInfo.size, mtimeMs: sourceInfo.mtimeMs })
  if (existsSync(marker)) {
    if (readFileSync(marker, 'utf8') !== fingerprint) {
      throw new Error(`Legacy Session changed after migration: ${source}; stop the old application and reconcile the preserved logs`)
    }
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.import-${randomUUID()}`
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL)
    const copiedSource = statSync(source)
    if (copiedSource.size !== sourceInfo.size || copiedSource.mtimeMs !== sourceInfo.mtimeMs) {
      throw new Error(`Session changed during migration: ${source}; stop the old application and retry`)
    }
    utimesSync(temporary, sourceInfo.atime, sourceInfo.mtime)
    try {
      // Linking a complete temporary file publishes it atomically and refuses an existing target.
      linkSync(temporary, target)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (!readFileSync(temporary).equals(readFileSync(target))) {
        throw new Error(`Session migration conflict: ${source} and ${target} differ; both files were preserved`, { cause: error })
      }
    }
    mkdirSync(dirname(marker), { recursive: true })
    const publishedSource = statSync(source)
    if (publishedSource.size !== sourceInfo.size || publishedSource.mtimeMs !== sourceInfo.mtimeMs) {
      throw new Error(`Session changed during migration: ${source}; both logs were preserved`)
    }
    writeFileSync(marker, fingerprint, 'utf8')
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function defaultRunSessionFile(workspace: string, version: number): string {
  const filename = `run-v${version}.jsonl`
  const target = join(workspaceSessionDir(workspace), filename)
  const legacy = join(resolve(workspace), '.tnega')
  let entries: string[]
  try {
    entries = readdirSync(legacy)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return target
    throw error
  }
  for (const entry of entries) {
    if (/^run-v\d+\.jsonl$/.test(entry)) {
      importLegacyFile(join(legacy, entry), join(workspaceSessionDir(workspace), entry))
    }
  }
  return target
}

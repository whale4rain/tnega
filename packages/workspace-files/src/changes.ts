import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolveInside } from '@tnega/tools'
import { FileServeError } from './files.js'
import { MAX_TEXT_FILE_BYTES } from './workspace-files.js'
import { isRuntimeFile } from './runtime-files.js'

/**
 * The Workbench Changes view: what differs in the workspace from the last
 * commit, file by file, with both sides of each file for the diff editor.
 * Paths are relative to the workspace, which may sit below the repository root.
 */

const run = promisify(execFile)
const MAX_FILES = 500

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface ChangedFile {
  path: string
  status: ChangeStatus
  previousPath?: string
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface ChangeSummary {
  git: boolean
  branch?: string
  files: ChangedFile[]
  truncated?: boolean
}

export interface FileDiff {
  path: string
  status: ChangeStatus
  /** `null` when the file is new; absent for binary or oversized files. */
  original?: string | null
  /** `null` when the file was deleted. */
  modified?: string | null
  reason?: 'binary' | 'too-large'
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  return stdout
}

async function repository(workspace: string): Promise<{ prefix: string; head: boolean } | undefined> {
  try {
    const prefix = (await git(workspace, ['rev-parse', '--show-prefix'])).trim()
    const head = await git(workspace, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false)
    return { prefix, head }
  } catch {
    return undefined
  }
}

function statusOf(code: string): ChangeStatus {
  if (code === '??') return 'untracked'
  if (code.includes('R')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  return 'modified'
}

/** `git status --porcelain=v1 -z` entries, with repository-root paths. */
export function parsePorcelain(output: string): Array<{ code: string; path: string; previousPath?: string }> {
  const entries = output.split('\0')
  const parsed: Array<{ code: string; path: string; previousPath?: string }> = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code.includes('R') || code.includes('C')) {
      const previousPath = entries[++index]
      parsed.push({ code, path, ...(previousPath ? { previousPath } : {}) })
    } else {
      parsed.push({ code, path })
    }
  }
  return parsed
}

function countLines(text: string): number {
  if (!text) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export async function listChanges(workspace: string): Promise<ChangeSummary> {
  const repo = await repository(workspace)
  if (!repo) return { git: false, files: [] }
  const branch = (await git(workspace, ['branch', '--show-current']).catch(() => '')).trim()
  const strip = (path: string) => path.startsWith(repo.prefix) ? path.slice(repo.prefix.length) : undefined
  const status = parsePorcelain(await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']))
  const numstat = new Map<string, { additions?: number; deletions?: number; binary?: boolean }>()
  if (repo.head) {
    for (const line of (await git(workspace, ['diff', 'HEAD', '--numstat', '--relative', '--', '.'])).split('\n')) {
      const [added, deleted, ...rest] = line.split('\t')
      const path = rest.join('\t')
      if (!path) continue
      // A rename prints `old => new`; the new side names the file.
      const name = path.includes(' => ') ? path.replace(/\{(.*) => (.*)\}/, '$2').replace(/^.* => /, '') : path
      numstat.set(name, added === '-' ? { binary: true } : { additions: Number(added), deletions: Number(deleted) })
    }
  }
  const files: ChangedFile[] = []
  for (const entry of status) {
    const path = strip(entry.path)
    if (path === undefined || isRuntimeFile(path)) continue
    const file: ChangedFile = { path, status: repo.head ? statusOf(entry.code) : 'added' }
    if (entry.previousPath) {
      const previous = strip(entry.previousPath)
      if (previous !== undefined) file.previousPath = previous
    }
    const stats = numstat.get(path)
    if (stats) Object.assign(file, stats)
    else if (file.status === 'untracked' || !repo.head) {
      const target = await resolveInside(workspace, path).catch(() => undefined)
      const info = target ? await stat(target).catch(() => undefined) : undefined
      if (target && info?.isFile() && info.size <= MAX_TEXT_FILE_BYTES) {
        const bytes = await readFile(target)
        if (bytes.subarray(0, 8192).includes(0)) file.binary = true
        else Object.assign(file, { additions: countLines(bytes.toString('utf8')), deletions: 0 })
      }
    }
    files.push(file)
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    git: true,
    ...(branch ? { branch } : {}),
    files: files.slice(0, MAX_FILES),
    ...(files.length > MAX_FILES ? { truncated: true } : {}),
  }
}

export async function fileDiff(workspace: string, path: string): Promise<FileDiff> {
  const repo = await repository(workspace)
  if (!repo) throw new FileServeError('workspace is not a git repository', 409)
  let target: string
  try {
    target = await resolveInside(workspace, path)
  } catch (error) {
    throw new FileServeError(error instanceof Error ? error.message : String(error), 400)
  }
  const change = (await listChanges(workspace)).files.find(file => file.path === path)
  const status = change?.status ?? 'modified'
  const info = await stat(target).catch(() => undefined)
  const working = info?.isFile() ? await readFile(target) : undefined
  const fromPath = `${repo.prefix}${change?.previousPath ?? path}`
  const committed = repo.head && status !== 'untracked' && status !== 'added'
    ? await run('git', ['show', `HEAD:${fromPath}`], { cwd: workspace, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
      .then(result => result.stdout, () => undefined)
    : undefined
  const sides: Buffer[] = []
  if (working) sides.push(working)
  if (committed) sides.push(committed)
  if (sides.some(side => side.byteLength > MAX_TEXT_FILE_BYTES)) return { path, status, reason: 'too-large' }
  if (sides.some(side => side.subarray(0, 8192).includes(0))) return { path, status, reason: 'binary' }
  return {
    path,
    status,
    original: committed ? committed.toString('utf8') : null,
    modified: working ? working.toString('utf8') : null,
  }
}

import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { promisify } from 'node:util'
import type { SessionEvent } from '@tnega/session'

const runFile = promisify(execFile)

interface GitBaseline {
  head: string
  prefix: string
  dirty: Map<string, { fingerprint: string | null; content: string | undefined }>
}

export interface EditedFile {
  path: string
  additions?: number
  deletions?: number
}

const MAX_DIFF_BYTES = 4 * 1024 * 1024

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

function pathsFromStatus(output: string): string[] {
  const entries = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (status.includes('R') || status.includes('C')) {
      const former = entries[++index]
      if (former) paths.push(former)
    }
  }
  return paths
}

function inside(workspace: string, path: string): string | undefined {
  const absolute = resolve(workspace, path)
  const rel = relative(workspace, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

async function fingerprint(workspace: string, path: string): Promise<string | null> {
  const safe = inside(workspace, path)
  if (!safe) return null
  try {
    const target = resolve(workspace, safe)
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) {
      return `link:${await readlink(target)}`
    }
    if (!stats.isFile()) return null
    return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.mode}`
  } catch {
    return null
  }
}

async function fileContent(workspace: string, path: string): Promise<string | undefined> {
  const safe = inside(workspace, path)
  if (!safe) return undefined
  try {
    const target = resolve(workspace, safe)
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) return await readlink(target)
    if (!stats.isFile() || stats.size > MAX_DIFF_BYTES) return undefined
    const buffer = await readFile(target)
    if (buffer.includes(0)) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\r\n/g, '\n')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return ''
    return undefined
  }
}

async function committedContent(workspace: string, baseline: GitBaseline, path: string): Promise<string | undefined> {
  if (!baseline.head) return ''
  try {
    const text = await git(workspace, ['show', `${baseline.head}:${baseline.prefix}${path}`])
    if (text.includes('\0') || Buffer.byteLength(text) > MAX_DIFF_BYTES) return undefined
    return text.replace(/\r\n/g, '\n')
  } catch (error) {
    // Git uses exit 128 when a path is absent from the starting commit.
    if (error && typeof error === 'object' && 'code' in error && error.code === 128) return ''
    return undefined
  }
}

async function lineStats(before: string, after: string, scratch: string, index: number): Promise<{ additions: number; deletions: number }> {
  const oldPath = join(scratch, `${index}-before`)
  const newPath = join(scratch, `${index}-after`)
  await Promise.all([writeFile(oldPath, before), writeFile(newPath, after)])
  let output: string
  try {
    output = await git(scratch, ['-c', 'color.ui=false', 'diff', '--no-index', '--no-ext-diff', '--numstat', '--', oldPath, newPath])
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1
      && 'stdout' in error && typeof error.stdout === 'string') output = error.stdout
    else throw error
  }
  const match = output.match(/^(\d+)\t(\d+)\t/m)
  if (!match && before !== after) throw new Error('Git did not report text line counts')
  return { additions: match ? Number(match[1]) : 0, deletions: match ? Number(match[2]) : 0 }
}

/** Capture only already dirty files; clean tracked files are compared through Git. */
export async function captureFileEditBaseline(workspace: string): Promise<GitBaseline | undefined> {
  try {
    const [head, prefix, status] = await Promise.all([
      git(workspace, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      git(workspace, ['rev-parse', '--show-prefix']),
      git(workspace, ['-c', 'status.relativePaths=true', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    ])
    const dirty = new Map<string, { fingerprint: string | null; content: string | undefined }>()
    await Promise.all(pathsFromStatus(status).map(async path => {
      const safe = inside(workspace, path)
      if (safe) dirty.set(safe, {
        fingerprint: await fingerprint(workspace, safe),
        content: await fileContent(workspace, safe),
      })
    }))
    return { head: head.trim(), prefix: prefix.trimEnd(), dirty }
  } catch {
    // Non-Git workspaces still report explicit write_file tool results.
    return undefined
  }
}

function writtenPaths(workspace: string, events: readonly SessionEvent[], afterSeq: number): string[] {
  const paths: string[] = []
  for (const event of events) {
    if (event.seq <= afterSeq || event.type !== 'tool/result'
      || event.payload.name !== 'write_file' || !event.payload.ok) continue
    const output = event.payload.output
    if (!output || typeof output !== 'object' || !('path' in output)
      || typeof output.path !== 'string') continue
    const safe = inside(workspace, output.path)
    if (safe) paths.push(safe)
  }
  return paths
}

/** Files changed during one Agent Run, including edits made by shell commands. */
export async function editedFiles(
  workspace: string,
  baseline: GitBaseline | undefined,
  events: readonly SessionEvent[],
  afterSeq: number,
): Promise<EditedFile[]> {
  const files = new Set(writtenPaths(workspace, events, afterSeq))
  if (!baseline) return [...files].sort().map(path => ({ path }))
  try {
    const [head, status] = await Promise.all([
      git(workspace, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      git(workspace, ['-c', 'status.relativePaths=true', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    ])
    const changed = new Set(pathsFromStatus(status).map(path => inside(workspace, path)).filter((path): path is string => path !== undefined))
    if (head.trim() !== baseline.head && head.trim()) {
      const committed = baseline.head
        ? await git(workspace, ['diff', '--name-only', '-z', '--relative', baseline.head, head.trim(), '--', '.'])
        : await git(workspace, ['ls-files', '-z', '--', '.'])
      for (const path of committed.split('\0')) {
        const safe = inside(workspace, path)
        if (safe) changed.add(safe)
      }
    }
    for (const path of baseline.dirty.keys()) changed.add(path)
    await Promise.all([...changed].map(async path => {
      const before = baseline.dirty.get(path)
      if (before !== undefined) {
        if (before.fingerprint !== await fingerprint(workspace, path)) files.add(path)
      } else if (changed.has(path)) {
        files.add(path)
      }
    }))
  } catch {
    // Git may disappear or become unavailable mid-run. Explicit writes remain.
  }
  const paths = [...files].sort()
  if (!paths.length) return []
  const scratch = await mkdtemp(join(tmpdir(), 'tnega-file-edits-')).catch(() => undefined)
  if (!scratch) return paths.map(path => ({ path }))
  try {
    return await Promise.all(paths.map(async (path, index): Promise<EditedFile> => {
      const before = baseline.dirty.has(path)
        ? baseline.dirty.get(path)?.content
        : await committedContent(workspace, baseline, path)
      const after = await fileContent(workspace, path)
      if (before === undefined || after === undefined) return { path }
      try { return { path, ...await lineStats(before, after, scratch, index) } }
      catch { return { path } }
    }))
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

import { execFile } from 'node:child_process'
import { lstat, readlink } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { promisify } from 'node:util'
import type { SessionEvent } from '@tnega/session'

const runFile = promisify(execFile)

interface GitBaseline {
  head: string
  dirty: Map<string, string | null>
}

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

/** Capture only already dirty files; clean tracked files are compared through Git. */
export async function captureFileEditBaseline(workspace: string): Promise<GitBaseline | undefined> {
  try {
    const [head, status] = await Promise.all([
      git(workspace, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      git(workspace, ['-c', 'status.relativePaths=true', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    ])
    const dirty = new Map<string, string | null>()
    await Promise.all(pathsFromStatus(status).map(async path => {
      const safe = inside(workspace, path)
      if (safe) dirty.set(safe, await fingerprint(workspace, safe))
    }))
    return { head: head.trim(), dirty }
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
): Promise<string[]> {
  const files = new Set(writtenPaths(workspace, events, afterSeq))
  if (!baseline) return [...files].sort()
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
        if (before !== await fingerprint(workspace, path)) files.add(path)
      } else if (changed.has(path)) {
        files.add(path)
      }
    }))
  } catch {
    // Git may disappear or become unavailable mid-run. Explicit writes remain.
  }
  return [...files].sort()
}

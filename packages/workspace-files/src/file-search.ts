import { localExecutionProvider } from '@tnega/execution'
import { DEFAULT_SEARCH_EXCLUDES } from '@tnega/search'
import { resolveRipgrepPath } from '@tnega/search-ripgrep'

/**
 * File search for the composer's `@` mentions: `rg --files` with the same flags and
 * default excludes as the workspace search provider, cached briefly because the UI
 * asks on every keystroke.
 *
 * It deliberately passes no positive `--glob`: ripgrep treats those as overrides
 * that win over ignore files, which would list gitignored files.
 */

const CACHE_MS = 10_000
const MAX_FILES = 20_000

const cache = new Map<string, { at: number, files: Promise<string[]> }>()

async function listFiles(workspace: string): Promise<string[]> {
  const argv = [
    await resolveRipgrepPath(),
    '--no-config', '--hidden', '--no-require-git', '--files', '--sort=modified',
    ...DEFAULT_SEARCH_EXCLUDES.map(name => `--glob=!**/${name}`),
  ]
  const result = await localExecutionProvider.runProcess({ argv, cwd: workspace, timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 })
  // Exit code 1 means "no files"; anything else is a real failure.
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.trim() || `ripgrep exited with ${result.exitCode}`)
  // `--sort=modified` lists oldest first; mentions want the newest first.
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(path => path.replaceAll('\\', '/'))
    .reverse()
    .slice(0, MAX_FILES)
}

export function workspaceFiles(workspace: string): Promise<string[]> {
  const cached = cache.get(workspace)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.files
  const files = listFiles(workspace)
  cache.set(workspace, { at: Date.now(), files })
  files.catch(() => cache.delete(workspace))
  return files
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index++
    if (index === needle.length) return true
  }
  return needle.length === 0
}

/**
 * Rank paths for a query: file-name prefix, then file-name substring, then path
 * substring, then a loose in-order match. An empty query keeps the original
 * order (most recently modified first).
 */
export function rankFiles(files: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase().replaceAll('\\', '/')
  if (!needle) return files.slice(0, limit)
  const scored: { path: string, score: number, order: number }[] = []
  files.forEach((path, order) => {
    const lower = path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const score = name.startsWith(needle) ? 0
      : name.includes(needle) ? 1
        : lower.includes(needle) ? 2
          : isSubsequence(needle, lower) ? 3
            : -1
    if (score >= 0) scored.push({ path, score, order })
  })
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.order - b.order)
  return scored.slice(0, limit).map(entry => entry.path)
}

export async function searchWorkspaceFiles(workspace: string, query: string, limit = 30): Promise<string[]> {
  return rankFiles(await workspaceFiles(workspace), query, Math.min(Math.max(1, limit), 100))
}

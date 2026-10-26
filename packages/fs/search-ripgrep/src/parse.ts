import type { ProcessResult } from '@tnega/execution'
import { SearchError, type SearchMatch } from '@tnega/search'

/** ripgrep's stderr signatures for "the pattern you gave me is not valid". */
const INVALID_PATTERN_PATTERN = /regex parse error|error parsing glob/i

/**
 * Reject a run that cannot be used: a nonzero exit other than ripgrep's
 * "no matches" code 1, or a capture that hit the byte cap. Partial stdout is
 * never parsed as if it were the whole result.
 *
 * @throws SearchError with `SEARCH_INVALID_PATTERN`, `SEARCH_OUTPUT_OVERFLOW`,
 *   or `SEARCH_FAILED`.
 */
export function assertSearchSucceeded(
  label: string,
  result: ProcessResult,
  maxBytes: number,
): void {
  const stderr = result.stderr.trim()
  if (result.exitCode === 0 || result.exitCode === 1) {
    if (result.stdoutTruncated) {
      throw new SearchError(
        `${label} produced more output than the ${maxBytes}-byte cap; narrow pattern, path, or glob and retry`,
        'SEARCH_OUTPUT_OVERFLOW',
      )
    }
    return
  }
  if (INVALID_PATTERN_PATTERN.test(stderr)) {
    throw new SearchError(`${label} pattern rejected: ${stderr}`, 'SEARCH_INVALID_PATTERN')
  }
  throw new SearchError(
    `${label} search failed (exit ${result.exitCode})${stderr.length > 0 ? `: ${stderr}` : ''}`,
    'SEARCH_FAILED',
  )
}

/** Split one `rg --files` capture into workspace-relative paths. */
export function parseGlobPaths(label: string, stdout: string): string[] {
  const paths: string[] = []
  for (const line of stdout.split('\n')) {
    const path = line.trim()
    if (!path) continue
    if (path.includes('\0')) {
      throw new SearchError(`${label} received malformed path output`, 'SEARCH_FAILED')
    }
    paths.push(path.split('\\').join('/'))
  }
  return paths
}

interface RipgrepMatchData {
  path?: unknown
  line_number?: unknown
  lines?: unknown
}

function malformed(label: string, detail: string): SearchError {
  return new SearchError(`${label} received malformed ripgrep output (${detail})`, 'SEARCH_FAILED')
}

/**
 * Parse one `rg --json` NDJSON line. Records other than `match` are transport
 * framing and are skipped; a `match` record missing its path, line number, or
 * content is malformed output rather than a partial result.
 */
function parseGrepRecord(label: string, line: string): SearchMatch | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw malformed(label, 'a line is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw malformed(label, 'a record is not an object')
  }
  const record = parsed as { type?: unknown; data?: unknown }
  if (record.type !== 'match') return undefined
  if (typeof record.data !== 'object' || record.data === null) {
    throw malformed(label, 'a match record has no data')
  }
  const data = record.data as RipgrepMatchData
  const path = typeof data.path === 'object' && data.path !== null
    ? (data.path as { text?: unknown }).text
    : undefined
  if (typeof path !== 'string') throw malformed(label, 'a match record has no path')
  if (typeof data.line_number !== 'number') {
    throw malformed(label, 'a match record has no line number')
  }
  if (typeof data.lines !== 'object' || data.lines === null) {
    throw malformed(label, 'a match record has no line content')
  }
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  const text = typeof lines.text === 'string'
    ? lines.text.replace(/\r?\n$/, '')
    : typeof lines.bytes === 'string'
      ? '(line is not valid UTF-8)'
      : undefined
  if (text === undefined) {
    throw malformed(label, 'a match record has neither text nor bytes')
  }
  return { file: path.split('\\').join('/'), line: data.line_number, text }
}

/** Parse a complete `rg --json` capture into flat matches, in output order. */
export function parseGrepMatches(label: string, stdout: string): SearchMatch[] {
  const matches: SearchMatch[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const match = parseGrepRecord(label, line)
    if (match) matches.push(match)
  }
  return matches
}

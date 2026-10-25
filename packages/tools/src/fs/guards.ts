import { ToolInputError } from '../errors.js'
import { observationOf } from './observed.js'
import type { FileToolsConfig } from './types.js'

/** What the target looks like right now, as far as the guard cares. */
export type CurrentVersion = { kind: 'present'; sha256: string } | { kind: 'absent' }

export interface GuardVerdict {
  /** Set in `warn` mode: the caller proceeds and says what it may have overwritten. */
  warning?: string
}

/**
 * Check a mutation against what this Agent has already seen of the path.
 *
 * - `off`: no check at all.
 * - `warn` (default): record and mutate, but say so when the version moved.
 * - `enforce`: refuse an unread target, and refuse one that changed since the
 *   read, naming the version to re-read against.
 *
 * Creating a file always passes: reading something that does not exist yet is
 * not a precondition for making it.
 */
export function checkObserved(
  config: FileToolsConfig,
  agentId: string | undefined,
  target: string,
  displayPath: string,
  current: CurrentVersion,
): GuardVerdict {
  if (config.fsGuard === 'off' || current.kind === 'absent') return {}
  const observed = observationOf(agentId, target)
  if (!observed) {
    const remedy = `read it with read_file first, then retry`
    if (config.fsGuard === 'enforce') {
      throw new ToolInputError(`${displayPath} has not been read in this session — ${remedy}`)
    }
    return { warning: `${displayPath} was not read in this session before this write; ${remedy} to be sure you are not overwriting something you have not seen.` }
  }
  if (observed.kind === 'present' && observed.sha256 === current.sha256) return {}
  const now = current.sha256.slice(0, 12)
  if (config.fsGuard === 'enforce') {
    throw new ToolInputError(
      `${displayPath} changed since it was read — it is now sha256 ${now}…; read it again, then retry`,
    )
  }
  return {
    warning: `${displayPath} changed since it was read (now sha256 ${now}…); this write may have overwritten another change.`,
  }
}

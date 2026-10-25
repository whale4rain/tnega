import { createHash } from 'node:crypto'

/**
 * What one Agent has seen of one path, so a later write can tell "I am
 * overwriting what I read" from "someone changed it under me".
 *
 * The record is per process and per Agent: it is deliberately not persisted.
 * A resumed session starts with nothing observed and has to read a file again
 * before a guarded write of it succeeds — the same limit the reference harness
 * accepts, and the reason a `warn` result explains itself instead of failing.
 */
export type Observation =
  | { kind: 'present'; sha256: string }
  | { kind: 'absent' }

/** A file's content identity. Content, not mtime: filesystem timestamps lie. */
export function fingerprint(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** How many paths one process remembers before the oldest are dropped. */
const MAX_OBSERVATIONS = 4096

const observations = new Map<string, Observation>()

function key(agentId: string | undefined, target: string): string {
  return `${agentId ?? ''}\u0000${target}`
}

export function recordObservation(agentId: string | undefined, target: string, value: Observation): void {
  const entry = key(agentId, target)
  observations.delete(entry)
  observations.set(entry, value)
  for (const oldest of observations.keys()) {
    if (observations.size <= MAX_OBSERVATIONS) break
    observations.delete(oldest)
  }
}

export function observationOf(agentId: string | undefined, target: string): Observation | undefined {
  return observations.get(key(agentId, target))
}

/** Drop what one Agent saw; a test and a disposed runtime both use it. */
export function forgetObservations(agentId?: string): void {
  if (agentId === undefined) {
    observations.clear()
    return
  }
  const prefix = `${agentId}\u0000`
  for (const entry of [...observations.keys()]) {
    if (entry.startsWith(prefix)) observations.delete(entry)
  }
}

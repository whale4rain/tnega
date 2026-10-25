import { createHash } from 'node:crypto'

/**
 * What one Agent has seen of one path, so a later write can tell "I am
 * overwriting what I read" from "someone changed it under me".
 *
 * The record is deliberately not persisted: a resumed session starts with
 * nothing observed and has to read a file again before a guarded write of it
 * succeeds — the same limit the reference harness accepts, and the reason a
 * `warn` result explains itself instead of failing.
 */
export type Observation =
  | { kind: 'present'; sha256: string }
  | { kind: 'absent' }

/** A file's content identity. Content, not mtime: filesystem timestamps lie. */
export function fingerprint(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** How many paths one store remembers before the oldest are dropped. */
const MAX_OBSERVATIONS = 4096

/**
 * The observations of one file-tools scope, keyed by Agent and path.
 *
 * Owned by the plugin that registered the tools, so it goes away with that
 * plugin: two runtimes in one host process never see each other's reads.
 */
export class ObservationStore {
  private readonly entries = new Map<string, Observation>()

  constructor(private readonly limit = MAX_OBSERVATIONS) {}

  private key(agentId: string | undefined, target: string): string {
    return `${agentId ?? ''}\u0000${target}`
  }

  record(agentId: string | undefined, target: string, value: Observation): void {
    const entry = this.key(agentId, target)
    this.entries.delete(entry)
    this.entries.set(entry, value)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break
      this.entries.delete(oldest)
    }
  }

  get(agentId: string | undefined, target: string): Observation | undefined {
    return this.entries.get(this.key(agentId, target))
  }

  /** Drop what one Agent saw, or everything when no Agent is named. */
  forget(agentId?: string): void {
    if (agentId === undefined) {
      this.entries.clear()
      return
    }
    const prefix = `${agentId}\u0000`
    for (const entry of [...this.entries.keys()]) {
      if (entry.startsWith(prefix)) this.entries.delete(entry)
    }
  }
}

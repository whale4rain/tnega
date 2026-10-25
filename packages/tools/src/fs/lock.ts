/**
 * Per-path serialization for read-modify-write tools.
 *
 * An atomic publish makes a half-written file invisible, but it does not stop
 * two callers from reading the same version and each writing a different edit:
 * the second publish silently drops the first one. Two Subagents editing one
 * file is the ordinary case where that happens, so the read, the check and the
 * publish of one path run under one lock.
 */
interface Tail {
  /** Resolves when the last queued piece of work for this path has settled. */
  promise: Promise<unknown>
  pending: number
}

const tails = new Map<string, Tail>()

export async function withPathLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const existing = tails.get(target)
  const tail: Tail = existing ?? { promise: Promise.resolve(), pending: 0 }
  if (!existing) tails.set(target, tail)
  tail.pending += 1
  const previous = tail.promise
  // A predecessor's failure belongs to its own caller; this work still runs.
  const current = previous.then(work, work)
  tail.promise = current.then(() => undefined, () => undefined)
  try {
    return await current
  } finally {
    tail.pending -= 1
    if (tail.pending === 0 && tails.get(target) === tail) tails.delete(target)
  }
}

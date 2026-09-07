/**
 * Invariant companion support.
 *
 * Layered defense, mirroring the DSH "each package ships a `./invariant`"
 * discipline: every package that owns durable or live relationships exports a
 * set of checks that continuously assert cross-event / cross-data invariants
 * (open/close pairing, monotonic sequence, ownership). The checks are pure
 * over the data they observe, so they can run at any time: on load, on each
 * commit, or on demand during tests and debugging.
 */

export interface InvariantContext {
  /**
   * The durable events observed so far. A check runs over whatever slice the
   * caller supplies (the full log, a single appended event, …).
   */
  events: readonly unknown[]
  [key: string]: unknown
}

/** A check returns a list of violated descriptions; an empty list means pass. */
export type InvariantCheck = (
  context: InvariantContext,
) => readonly string[] | Promise<readonly string[]>

export interface InvariantDefinition {
  /** Stable, package-scoped name, e.g. `session/open-lifecycle`. */
  name: string
  /** When this check does not apply, explain why in one line. */
  describe(): string
  check: InvariantCheck
}

export class InvariantRegistry {
  private _checks = new Map<string, InvariantDefinition>()

  register(definition: InvariantDefinition): () => void {
    if (this._checks.has(definition.name)) {
      throw new Error(`invariant already registered: ${definition.name}`)
    }
    this._checks.set(definition.name, definition)
    return () => {
      this._checks.delete(definition.name)
    }
  }

  has(name: string): boolean {
    return this._checks.has(name)
  }

  list(): readonly InvariantDefinition[] {
    return [...this._checks.values()]
  }

  async runAll(context: InvariantContext): Promise<readonly string[]> {
    const violations: string[] = []
    for (const definition of this._checks.values()) {
      const found = await definition.check(context)
      violations.push(...found)
    }
    return violations
  }
}

export class InvariantViolationError extends Error {
  override name = 'InvariantViolationError'

  constructor(readonly violations: readonly string[]) {
    super(violations.join('; '))
  }
}

/** Fail-fast helper: throws when any registered invariant reports a violation. */
export function assertInvariants(
  violations: readonly string[],
): void {
  if (violations.length) throw new InvariantViolationError(violations)
}

export const invariant = {
  name: 'invariants',
  apply: (ctx: import('./context.js').Context) => {
    const registry = new InvariantRegistry()
    ctx.provide('invariants', registry)
    return () => {}
  },
}

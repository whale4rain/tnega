export interface RateLimit {
  /** Failures allowed in one window before the address is locked out. */
  failures: number
  windowMs: number
  lockMs: number
}

/** §4.6: five failures a minute, then a lockout. */
export const DEFAULT_RATE_LIMIT: RateLimit = { failures: 5, windowMs: 60_000, lockMs: 5 * 60_000 }

/**
 * Failed sign-ins and code exchanges per source address. In memory: a
 * restart forgets it, which costs an attacker a restart they cannot cause.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>()
  private readonly locked = new Map<string, number>()

  constructor(private readonly limit: RateLimit = DEFAULT_RATE_LIMIT, private readonly now: () => number = Date.now) {}

  /** Milliseconds the address must still wait, or 0. */
  blockedFor(address: string): number {
    const until = this.locked.get(address)
    if (until === undefined) return 0
    const left = until - this.now()
    if (left > 0) return left
    this.locked.delete(address)
    return 0
  }

  fail(address: string): void {
    const now = this.now()
    const recent = (this.failures.get(address) ?? []).filter(at => now - at < this.limit.windowMs)
    recent.push(now)
    if (recent.length >= this.limit.failures) {
      this.locked.set(address, now + this.limit.lockMs)
      this.failures.delete(address)
    } else {
      this.failures.set(address, recent)
    }
    // Keep the maps from growing without end under a spray of addresses.
    if (this.failures.size > 10_000) {
      for (const [key, times] of this.failures) if (times.every(at => now - at >= this.limit.windowMs)) this.failures.delete(key)
    }
  }

  succeed(address: string): void {
    this.failures.delete(address)
  }
}

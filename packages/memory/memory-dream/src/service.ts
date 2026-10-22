import { resolve } from 'node:path'
import type { LLMAdapter } from '@tnega/agent'
import { Service, type Context } from '@tnega/core'
import type { MemoryService } from '@tnega/memory'
import { DREAM_DEFAULTS, dreamLedgerFile, dreamWorkspace, readDreamLedger, type DreamOutcome } from './dream.js'

declare module '@tnega/core' {
  interface ServiceMap {
    memoryDream: MemoryDreamService
  }
}

export interface DreamSettings {
  enabled: boolean
  /** Minutes a session stays quiet before it is dreamed. */
  idleMinutes: number
}

/** A workspace's memory, opened for one dream and closed after it. */
export interface DreamMemoryHandle {
  memory: MemoryService
  dispose: () => Promise<void>
}

export interface MemoryDreamOptions {
  /** Workspaces to look after; read again on every pass. */
  workspaces: () => Promise<readonly string[]>
  settings: () => Promise<DreamSettings>
  /** The model a dream asks; `undefined` when none is configured. */
  resolveAdapter: () => Promise<LLMAdapter | undefined>
  /** Composition picks the memory provider; this consumer never imports one. */
  openMemory: (workspace: string) => Promise<DreamMemoryHandle>
  /** Time between passes. Defaults to five minutes. */
  intervalMs?: number
  /** Delay before the first pass after start. Defaults to one minute. */
  firstDelayMs?: number
  /** Shortest time between two automatic dreams of one workspace. Defaults to 15 minutes. */
  minGapMs?: number
  /** Wait after a failed dream before trying that workspace again. Defaults to 30 minutes. */
  failureBackoffMs?: number
  now?: () => number
}

export interface DreamState {
  enabled: boolean
  running: boolean
  last?: DreamOutcome
}

/**
 * Dreaming: in the background, fold sessions that changed and went quiet into
 * their workspace's project memory. One dream runs at a time across all
 * workspaces, so a burst of sessions never becomes a burst of requests.
 */
export class MemoryDreamService extends Service {
  private timer: ReturnType<typeof setTimeout> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly running = new Set<string>()
  private readonly lastAttempt = new Map<string, { at: number; failed: boolean }>()
  private readonly controller = new AbortController()
  private closed = false

  constructor(ctx: Context, private readonly config: MemoryDreamOptions) {
    super(ctx, 'memoryDream')
    ctx.fiber.effect(() => {
      this.arm(config.firstDelayMs ?? 60_000)
      return () => this.close()
    }, 'memory dreaming')
  }

  private now(): number {
    return (this.config.now ?? Date.now)()
  }

  private arm(delay: number): void {
    if (this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pass().finally(() => this.arm(this.config.intervalMs ?? 5 * 60_000))
    }, delay)
    this.timer.unref?.()
  }

  private async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.controller.abort()
    await this.tail.catch(() => {})
  }

  /** One automatic pass over every workspace that is due. */
  async pass(): Promise<void> {
    if (this.closed) return
    let settings: DreamSettings
    let workspaces: readonly string[]
    try {
      settings = await this.config.settings()
      if (!settings.enabled) return
      workspaces = await this.config.workspaces()
    } catch (error) {
      this.ctx.logger.warn(`memory dreaming could not start a pass: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const now = this.now()
    for (const raw of workspaces) {
      const workspace = resolve(raw)
      const attempt = this.lastAttempt.get(workspace)
      const wait = attempt?.failed ? this.config.failureBackoffMs ?? 30 * 60_000 : this.config.minGapMs ?? 15 * 60_000
      if (attempt && now - attempt.at < wait) continue
      await this.dream(workspace, { idleMs: settings.idleMinutes * 60_000 }).catch(() => {})
    }
  }

  /**
   * Dream one workspace now. `idleMs: 0` also reads sessions that are still
   * active, which is what an explicit request wants.
   */
  dream(workspace: string, options: { idleMs?: number } = {}): Promise<DreamOutcome> {
    const key = resolve(workspace)
    const work = this.tail.then(() => this.run(key, options.idleMs ?? DREAM_DEFAULTS.idleMs))
    this.tail = work.catch(() => {})
    return work
  }

  private async run(workspace: string, idleMs: number): Promise<DreamOutcome> {
    if (this.closed) throw new Error('memory dreaming has stopped')
    this.running.add(workspace)
    let handle: DreamMemoryHandle | undefined
    try {
      const llm = await this.config.resolveAdapter()
      if (!llm) {
        const outcome: DreamOutcome = { status: 'failed', at: this.now(), sessions: 0, reason: 'no model is configured' }
        this.lastAttempt.set(workspace, { at: outcome.at, failed: true })
        return outcome
      }
      handle = await this.config.openMemory(workspace)
      const outcome = await dreamWorkspace({
        workspace,
        memory: handle.memory,
        llm,
        idleMs,
        signal: this.controller.signal,
        ...(this.config.now ? { now: this.config.now } : {}),
      })
      this.lastAttempt.set(workspace, { at: outcome.at, failed: outcome.status === 'failed' })
      if (outcome.status === 'failed') this.ctx.logger.warn(`memory dream failed for ${workspace}: ${outcome.reason ?? 'unknown'}`)
      return outcome
    } catch (error) {
      this.lastAttempt.set(workspace, { at: this.now(), failed: true })
      throw error
    } finally {
      this.running.delete(workspace)
      await handle?.dispose()
    }
  }

  async state(workspace: string): Promise<DreamState> {
    const key = resolve(workspace)
    const [settings, ledger] = await Promise.all([this.config.settings(), readDreamLedger(dreamLedgerFile(key))])
    return {
      enabled: settings.enabled,
      running: this.running.has(key),
      ...(ledger.last ? { last: ledger.last } : {}),
    }
  }
}

export const memoryDream = {
  name: 'memory-dream',
  apply(ctx: Context, config: MemoryDreamOptions): void {
    new MemoryDreamService(ctx, config)
  },
}

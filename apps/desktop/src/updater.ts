/**
 * Self-update for the packaged desktop app.
 *
 * electron-updater reads the feed that electron-builder publishes beside each
 * GitHub release (`latest.yml`), downloads the new installer in the background
 * and runs it on restart. This module turns its events into one small state the
 * renderer can draw, and keeps the restart behind an explicit user action.
 */

export type UpdateState =
  /** Not a packaged build (development), so there is no feed to follow. */
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string; checkedAt?: number }
  | { status: 'checking'; version: string }
  | { status: 'downloading'; version: string; next: string; percent: number }
  | { status: 'ready'; version: string; next: string }
  | { status: 'error'; version: string; message: string; checkedAt?: number }

/** The part of electron-updater's `AppUpdater` this module drives. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdateControllerOptions {
  version: string
  /** `undefined` when the build cannot update itself (not packaged). */
  updater: UpdaterLike | undefined
  /** How often to look for a new release while the app runs. Defaults to 4 hours. */
  intervalMs?: number
  now?: () => number
}

export const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000

export class UpdateController {
  private current: UpdateState
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly updater: UpdaterLike | undefined
  private readonly version: string
  private readonly now: () => number

  constructor(private readonly options: UpdateControllerOptions) {
    this.version = options.version
    this.updater = options.updater
    this.now = options.now ?? Date.now
    this.current = this.updater ? { status: 'idle', version: this.version } : { status: 'unsupported', version: this.version }
    const updater = this.updater
    if (!updater) return
    updater.autoDownload = true
    // The app exits through `app.exit()`, which skips the quit hook this relies
    // on; `installOnExit()` covers that path instead.
    updater.autoInstallOnAppQuit = false
    updater.on('checking-for-update', () => {
      if (this.current.status !== 'ready' && this.current.status !== 'downloading') this.set({ status: 'checking', version: this.version })
    })
    updater.on('update-available', info => this.set({ status: 'downloading', version: this.version, next: info.version, percent: 0 }))
    updater.on('update-not-available', () => this.set({ status: 'idle', version: this.version, checkedAt: this.now() }))
    updater.on('download-progress', progress => {
      if (this.current.status !== 'downloading') return
      this.set({ ...this.current, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) })
    })
    updater.on('update-downloaded', info => this.set({ status: 'ready', version: this.version, next: info.version }))
    updater.on('error', error => {
      // A failed check must not hide an update that is already downloaded.
      if (this.current.status === 'ready') return
      this.set({ status: 'error', version: this.version, message: summarizeUpdateError(error), checkedAt: this.now() })
    })
  }

  state(): UpdateState {
    return this.current
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Check now, then on an interval. */
  start(): void {
    if (!this.updater || this.timer) return
    void this.check()
    this.timer = setInterval(() => { void this.check() }, this.options.intervalMs ?? UPDATE_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async check(): Promise<UpdateState> {
    const status = this.current.status
    if (!this.updater || status === 'checking' || status === 'downloading' || status === 'ready') return this.current
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      if (!this.ready()) {
        this.set({ status: 'error', version: this.version, message: summarizeUpdateError(error), checkedAt: this.now() })
      }
    }
    return this.current
  }

  /** Whether `install()` would restart into a new version. */
  ready(): boolean {
    return this.current.status === 'ready'
  }

  /** Run the downloaded installer and relaunch. The caller shuts the runtime down first. */
  install(): void {
    if (!this.updater || !this.ready()) return
    this.stop()
    this.updater.quitAndInstall(true, true)
  }

  /** Leaving the app with an update downloaded installs it silently, without relaunching. */
  installOnExit(): boolean {
    if (!this.updater || !this.ready()) return false
    this.stop()
    this.updater.quitAndInstall(true, false)
    return true
  }

  private set(state: UpdateState): void {
    this.current = state
    for (const listener of this.listeners) listener(state)
  }
}

/**
 * electron-updater errors carry response headers and stack traces; Settings has
 * room for one sentence. A release without its feed is the common case (a
 * build uploaded by hand), so it gets its own wording.
 */
export function summarizeUpdateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const missing = /Cannot find (latest[\w-]*\.yml) in the latest release artifacts \(([^)]*)\)/.exec(text)
  if (missing) {
    const tag = /\/download\/(v[^/]+)\//.exec(missing[2] ?? '')?.[1]
    return `The latest release${tag ? ` (${tag})` : ''} has no update feed (${missing[1]}) yet.`
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT|ECONNRESET/.test(text)) {
    return 'Could not reach GitHub to check for updates.'
  }
  const first = text.split('\n')[0]?.trim() || 'Unknown error'
  return first.length > 160 ? `${first.slice(0, 157)}…` : first
}

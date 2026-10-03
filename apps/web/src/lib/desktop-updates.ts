import { useCallback, useEffect, useState } from 'react'

/**
 * The desktop app's self-update state, as `apps/desktop/src/updater.ts` reports
 * it. In a browser there is no bridge and the hook returns `undefined`.
 */
export type UpdateChannel = 'stable' | 'preview'

export type UpdateState = { channel?: UpdateChannel } & (
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string; checkedAt?: number }
  | { status: 'checking'; version: string }
  | { status: 'downloading'; version: string; next: string; percent: number }
  | { status: 'ready'; version: string; next: string }
  | { status: 'error'; version: string; message: string; checkedAt?: number }
)

interface UpdatesBridge {
  state(): Promise<unknown>
  check(): Promise<unknown>
  install(): Promise<void>
  setChannel?(channel: UpdateChannel): Promise<unknown>
  onState(listener: (state: unknown) => void): () => void
}

function bridge(): UpdatesBridge | undefined {
  const desktop: unknown = Reflect.get(globalThis, 'tnegaDesktop')
  if (!desktop || typeof desktop !== 'object') return undefined
  const updates: unknown = Reflect.get(desktop, 'updates')
  if (!updates || typeof updates !== 'object') return undefined
  const methods = ['state', 'check', 'install', 'onState'] as const
  return methods.every(name => typeof Reflect.get(updates, name) === 'function') ? updates as UpdatesBridge : undefined
}

const STATUSES = new Set(['unsupported', 'idle', 'checking', 'downloading', 'ready', 'error'])

export function parseUpdateState(value: unknown): UpdateState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const status: unknown = Reflect.get(value, 'status')
  const version: unknown = Reflect.get(value, 'version')
  if (typeof status !== 'string' || !STATUSES.has(status) || typeof version !== 'string') return undefined
  const channel: unknown = Reflect.get(value, 'channel')
  if (channel !== undefined && channel !== 'stable' && channel !== 'preview') return undefined
  return value as UpdateState
}

export interface DesktopUpdates {
  state: UpdateState
  check: () => void
  install: () => void
  setChannel?: (channel: UpdateChannel) => Promise<void>
}

export function useDesktopUpdates(): DesktopUpdates | undefined {
  const [state, setState] = useState<UpdateState>()
  useEffect(() => {
    const updates = bridge()
    if (!updates) return
    let live = true
    void updates.state().then(value => {
      const parsed = parseUpdateState(value)
      if (live && parsed) setState(parsed)
    })
    const off = updates.onState(value => {
      const parsed = parseUpdateState(value)
      if (parsed) setState(parsed)
    })
    return () => { live = false; off() }
  }, [])
  const check = useCallback(() => {
    void bridge()?.check().then(value => {
      const parsed = parseUpdateState(value)
      if (parsed) setState(parsed)
    })
  }, [])
  const install = useCallback(() => { void bridge()?.install() }, [])
  const setChannel = useCallback(async (channel: UpdateChannel) => {
    const value = await bridge()?.setChannel?.(channel)
    const parsed = parseUpdateState(value)
    if (parsed) setState(parsed)
  }, [])
  return state ? { state, check, install, ...(bridge()?.setChannel ? { setChannel } : {}) } : undefined
}

/** One line for Settings: where the app stands relative to the latest release. */
export function describeUpdate(state: UpdateState): string {
  switch (state.status) {
    case 'unsupported': return 'Development build — updates come from installed releases.'
    case 'checking': return 'Checking for updates…'
    case 'downloading': return `Downloading ${state.next}… ${state.percent}%`
    case 'ready': return `Version ${state.next} is ready. Restart to update.`
    case 'error': return `Update check failed: ${state.message}`
    case 'idle': return state.checkedAt ? 'Tnega is up to date.' : 'Updates are checked automatically.'
  }
}

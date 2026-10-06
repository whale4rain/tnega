import { playNoticeChime } from './chime'
import type { StreamEvent } from './types'

/** One terminal notification per submitted run, never for an aborted stream. */
export function completionObserver(signal: AbortSignal, notify: (outcome: 'completed' | 'failed') => void = notifyDesktopCompletion): (event: StreamEvent) => void {
  let sent = false
  let failed = false
  return event => {
    if (sent || signal.aborted) return
    if (event.type === 'run/end') failed = event.run.finishReason !== 'stop'
    if (event.type === 'error') failed = true
    if (event.type === 'done' || event.type === 'error') {
      sent = true
      notify(failed ? 'failed' : 'completed')
    }
  }
}

const announced = new Set<string>()

/**
 * A question or approval is waiting on the user: badge the taskbar and chime
 * once per request, so an unattended run does not stall unnoticed.
 */
export function notifyDesktopWaiting(requestId: string, notify = notifyDesktopCompletion): void {
  if (announced.has(requestId)) return
  announced.add(requestId)
  notify('waiting')
}

function notifyDesktopCompletion(outcome: 'completed' | 'failed' | 'waiting'): void {
  const desktop: unknown = Reflect.get(globalThis, 'tnegaDesktop')
  if (desktop && typeof desktop === 'object' && 'notifyCompletion' in desktop && typeof desktop.notifyCompletion === 'function') {
    desktop.notifyCompletion(outcome)
  }
  playNoticeChime(outcome)
}

/**
 * A project thread reported, failed or needs a decision: notify once per
 * state change (`key` names the thread and the change), not once per render.
 */
export function notifyDesktopThread(key: string, outcome: 'completed' | 'failed' | 'waiting', notify = notifyDesktopCompletion): void {
  if (announced.has(key)) return
  announced.add(key)
  notify(outcome)
}

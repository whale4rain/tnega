import type { StreamEvent } from './types'

/** One terminal notification per submitted run, never for an aborted stream. */
export function completionObserver(signal: AbortSignal, notify = notifyDesktopCompletion): (event: StreamEvent) => void {
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

function notifyDesktopCompletion(outcome: 'completed' | 'failed'): void {
  const desktop: unknown = Reflect.get(globalThis, 'tnegaDesktop')
  if (!desktop || typeof desktop !== 'object' || !('notifyCompletion' in desktop)) return
  if (typeof desktop.notifyCompletion === 'function') desktop.notifyCompletion(outcome)
}

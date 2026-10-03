import { expect, it, vi } from 'vitest'
import { completionObserver, notifyDesktopWaiting } from './desktop-completion'

it('notifies once at stream completion, not on intermediate goal turns', () => {
  const notify = vi.fn()
  const observe = completionObserver(new AbortController().signal, notify)
  observe({ type: 'run/end', run: { output: 'First round', finishReason: 'stop' } })
  expect(notify).not.toHaveBeenCalled()
  observe({ type: 'done' })
  observe({ type: 'done' })
  expect(notify.mock.calls).toEqual([['completed']])
})

it('reports a failed run once even if done follows the error', () => {
  const notify = vi.fn()
  const observe = completionObserver(new AbortController().signal, notify)
  observe({ type: 'error', message: 'Provider failed' })
  observe({ type: 'done' })
  expect(notify.mock.calls).toEqual([['failed']])
})

it('does not notify for cancellation or an unfinished stream', () => {
  const notify = vi.fn()
  const controller = new AbortController()
  const observe = completionObserver(controller.signal, notify)
  observe({ type: 'run/end', run: { output: '', finishReason: 'stop' } })
  controller.abort()
  observe({ type: 'done' })
  expect(notify).not.toHaveBeenCalled()
})

it('announces each waiting question or approval once', () => {
  const notify = vi.fn()
  notifyDesktopWaiting('question-1', notify)
  notifyDesktopWaiting('question-1', notify)
  notifyDesktopWaiting('approval-2', notify)
  expect(notify.mock.calls).toEqual([['waiting'], ['waiting']])
})

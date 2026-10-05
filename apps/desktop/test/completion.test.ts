import { expect, it, vi } from 'vitest'
import { installCompletionNotice } from '../src/completion.js'

it('shows an unread taskbar badge without flashing the button and clears it on focus', () => {
  let focus = () => {}
  const window = {
    isDestroyed: () => false, isFocused: () => false,
    setOverlayIcon: vi.fn(), flashFrame: vi.fn(),
    on: (_event: 'focus', listener: () => void) => { focus = listener },
    removeListener: vi.fn(),
  }
  const notice = installCompletionNotice(window, { completed: 'rain.png', failed: 'storm.png', waiting: 'snow.png' }, 'win32')
  notice.notify('waiting')
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith('snow.png', 'Waiting for your answer')
  notice.notify('completed')
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith('rain.png', 'Reply ready')
  notice.notify('failed')
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith('storm.png', 'Session failed')
  expect(window.flashFrame).not.toHaveBeenCalled()
  focus()
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
  notice.dispose()
  expect(window.removeListener).toHaveBeenCalledWith('focus', focus)
})

it('ignores invalid IPC payloads, closed windows and focused windows', () => {
  const window = {
    isDestroyed: vi.fn(() => false), isFocused: vi.fn(() => true),
    setOverlayIcon: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
  }
  const notice = installCompletionNotice(window, { completed: 'rain.png', failed: 'storm.png', waiting: 'snow.png' }, 'win32')
  notice.notify({ outcome: 'completed' })
  notice.notify('completed')
  window.isFocused.mockReturnValue(false)
  window.isDestroyed.mockReturnValue(true)
  notice.notify('failed')
  expect(window.setOverlayIcon).not.toHaveBeenCalled()
})

import { expect, it, vi } from 'vitest'
import { installCompletionNotice } from '../src/completion.js'

it('sounds once per notice, shows an unread taskbar badge and clears on focus', () => {
  let focus = () => {}
  const window = {
    isDestroyed: () => false, isFocused: () => false,
    setOverlayIcon: vi.fn(), flashFrame: vi.fn(),
    on: (_event: 'focus', listener: () => void) => { focus = listener },
    removeListener: vi.fn(),
  }
  const beep = vi.fn()
  const notice = installCompletionNotice(window, { completed: 'rain.png', failed: 'storm.png', waiting: 'snow.png' }, beep, 'win32')
  notice.notify('waiting')
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith('snow.png', 'Waiting for your answer')
  expect(window.flashFrame).toHaveBeenLastCalledWith(true)
  notice.notify('completed')
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith('rain.png', 'Reply ready')
  notice.notify('failed')
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith('storm.png', 'Session failed')
  expect(beep).toHaveBeenCalledTimes(3)
  focus()
  expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
  expect(window.flashFrame).toHaveBeenLastCalledWith(false)
  notice.dispose()
  expect(window.removeListener).toHaveBeenCalledWith('focus', focus)
})

it('ignores invalid IPC payloads and closed windows; focused windows only sound', () => {
  const window = {
    isDestroyed: vi.fn(() => false), isFocused: () => true,
    setOverlayIcon: vi.fn(), flashFrame: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
  }
  const beep = vi.fn()
  const notice = installCompletionNotice(window, { completed: 'rain.png', failed: 'storm.png', waiting: 'snow.png' }, beep, 'win32')
  notice.notify({ outcome: 'completed' })
  notice.notify('completed')
  window.isDestroyed.mockReturnValue(true)
  notice.notify('failed')
  expect(beep).toHaveBeenCalledTimes(1)
  expect(window.setOverlayIcon).not.toHaveBeenCalled()
})

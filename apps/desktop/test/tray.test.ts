import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Tray: class extends EventEmitter {
      setToolTip = vi.fn()
      setContextMenu = vi.fn()
      destroy = vi.fn()
    },
    Menu: { buildFromTemplate: vi.fn(template => template) },
  }
})

import { Menu } from 'electron'
import { installTray } from '../src/tray.js'

class Window extends EventEmitter {
  hide = vi.fn()
  show = vi.fn()
  restore = vi.fn()
  focus = vi.fn()
  isMinimized = () => true
}

describe('desktop tray', () => {
  it('keeps a minimized window in the taskbar without quitting', () => {
    const window = new Window()
    const quit = vi.fn()
    const tray = installTray(window, 'icon.png', quit)
    window.emit('minimize')
    expect(window.hide).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    tray.dispose()
  })

  it('prevents closing and restores from the tray without quitting', () => {
    const window = new Window()
    const quit = vi.fn()
    const tray = installTray(window, 'icon.png', quit)
    const event = { preventDefault: vi.fn() }
    window.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    tray.tray.emit('click')
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    tray.dispose()
    expect(window.listenerCount('close')).toBe(0)
    const closing = { preventDefault: vi.fn() }
    window.emit('close', closing)
    expect(closing.preventDefault).not.toHaveBeenCalled()
  })

  it('provides an explicit exit action', () => {
    const window = new Window()
    const quit = vi.fn()
    const tray = installTray(window, 'icon.png', quit)
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0]
    const exit = template?.find(item => item.label === 'Exit Tnega')
    if (!exit?.click) throw new Error('missing exit action')
    Reflect.apply(exit.click, undefined, [])
    expect(quit).toHaveBeenCalledOnce()
    tray.dispose()
  })
})

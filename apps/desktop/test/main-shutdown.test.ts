import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  close: vi.fn(async () => {}), disposeBrowser: vi.fn(async () => {}),
  disposeTray: vi.fn(), exit: vi.fn(), quit: vi.fn(),
  ready: Promise.resolve(), quitFromTray: () => {},
}))

class Window extends EventEmitter {
  static windows: Window[] = []
  destroyed = false
  webContents = { setWindowOpenHandler: vi.fn(), send: vi.fn() }
  constructor() { super(); Window.windows.push(this) }
  maximize() {}
  async loadURL() {}
  destroy() {
    this.destroyed = true
    Window.windows = Window.windows.filter(window => window !== this)
    this.emit('closed')
  }
  static getAllWindows() { return Window.windows }
}

const app = new EventEmitter()
vi.mock('electron', () => ({
  app: Object.assign(app, {
    isPackaged: false, whenReady: () => fixture.ready, getPath: () => 'unused',
    getVersion: () => '0.0.0', exit: fixture.exit, quit: fixture.quit,
    commandLine: { appendSwitch: vi.fn() },
  }),
  BrowserWindow: Window,
  dialog: {}, ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: { setApplicationMenu: vi.fn() }, nativeImage: { createFromPath: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false }, net: {}, shell: {},
  utilityProcess: { fork: vi.fn() },
}))
vi.mock('@tnega/cli', () => ({
  defaultHotProfile: vi.fn(),
  startWebServer: async () => ({ url: 'http://localhost:1234', close: fixture.close }),
}))
vi.mock('../src/browser.js', () => ({
  enableBrowserDebugging: vi.fn(),
  DesktopBrowser: class { host = {}; dispose = fixture.disposeBrowser },
}))
vi.mock('../src/tray.js', () => ({
  installTray: (_window: unknown, _icon: string, quit: () => void) => {
    fixture.quitFromTray = quit
    return { dispose: fixture.disposeTray }
  },
}))
vi.mock('../src/completion.js', () => ({ installCompletionNotice: () => ({ dispose: vi.fn() }) }))
vi.mock('../src/update-preferences.js', () => ({ readUpdateChannel: () => 'stable', saveUpdateChannel: vi.fn() }))
vi.mock('../src/ptc-assets.js', () => ({ desktopPtcAssets: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: () => true }))
vi.mock('electron-updater', () => ({ default: {} }))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  app.removeAllListeners()
  Window.windows = []
  fixture.close.mockImplementation(async () => {})
  await import('../src/main.js')
  // Let the ready/create-window continuation install the tray and app listeners.
  await new Promise(resolve => setImmediate(resolve))
})

afterEach(() => {
  app.emit('will-quit')
  vi.useRealTimers()
})

test('tray Exit removes every window before waiting for stalled runtime cleanup', async () => {
  vi.useFakeTimers()
  fixture.close.mockImplementation(() => new Promise(() => {}))
  const window = Window.windows[0]
  if (!window) throw new Error('missing main window')
  fixture.quitFromTray()
  expect(window.destroyed).toBe(true)
  expect(fixture.disposeTray).toHaveBeenCalledOnce()
  expect(fixture.exit).not.toHaveBeenCalled()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fixture.exit).toHaveBeenCalledWith(0)
  log.mockRestore()
  app.emit('activate')
  expect(Window.windows).toHaveLength(0)
})

test('an unexpectedly destroyed main window also exits its runtime', async () => {
  const window = Window.windows[0]
  if (!window) throw new Error('missing main window')
  window.destroy()
  await new Promise(resolve => setImmediate(resolve))
  expect(fixture.close).toHaveBeenCalledOnce()
  expect(fixture.disposeBrowser).toHaveBeenCalledOnce()
  expect(fixture.exit).toHaveBeenCalledWith(0)
})

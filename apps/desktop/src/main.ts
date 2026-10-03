import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultHotProfile, startWebServer, type WebServer } from '@tnega/cli'
import { DesktopBrowser, enableBrowserDebugging } from './browser.js'
import { closeDesktopRuntime } from './shutdown.js'
import { installTray } from './tray.js'
import { installCompletionNotice } from './completion.js'
import { DEFAULT_TITLE_BAR_COLORS, TITLE_BAR_HEIGHT, parseTitleBarColors } from './titlebar.js'
import { UpdateController, type UpdaterLike } from './updater.js'
import { readUpdateChannel, saveUpdateChannel } from './update-preferences.js'
import { desktopPtcAssets } from './ptc-assets.js'
import electronUpdater from 'electron-updater'

let server: WebServer | undefined
let browser: DesktopBrowser | undefined
let allowedOrigin = ''
let quitting = false
let tray: ReturnType<typeof installTray> | undefined
let updates: UpdateController | undefined
let completion: ReturnType<typeof installCompletionNotice> | undefined

/** Only an installed build has a release feed (`app-update.yml`) to follow. */
function createUpdates(): UpdateController {
  const updater: UpdaterLike | undefined = app.isPackaged ? electronUpdater.autoUpdater : undefined
  const preferences = join(app.getPath('userData'), 'update-preferences.json')
  const controller = new UpdateController({
    version: app.getVersion(), updater,
    channel: readUpdateChannel(preferences),
    saveChannel: channel => saveUpdateChannel(preferences, channel),
  })
  controller.subscribe(state => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tnega:update-state', state)
  })
  return controller
}

function appRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'tnega-runtime')
  return join(dirname(fileURLToPath(import.meta.url)), '../../..')
}

function webRoot(): string {
  const root = appRoot()
  const candidate = join(root, 'dist', 'web')
  if (!existsSync(candidate)) throw new Error(`Tnega web assets not found at ${candidate}`)
  return candidate
}

// The agent browser is driven over the local DevTools endpoint; see browser.ts.
enableBrowserDebugging()

function isTrustedSender(senderUrl: string): boolean {
  try {
    return new URL(senderUrl).origin === allowedOrigin
  } catch {
    return false
  }
}

function installDesktopHandlers(): void {
  ipcMain.on('tnega:completion', (event, outcome: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return
    completion?.notify(outcome)
  })
  ipcMain.handle('tnega:pick-folder', async event => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return undefined
    const options: OpenDialogOptions = {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle('tnega:reveal-workspace', async (event, path: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '') || typeof path !== 'string') return
    await shell.openPath(path)
  })
  ipcMain.on('tnega:title-bar-colors', (event, value: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return
    const colors = parseTitleBarColors(value)
    if (!colors) return
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({
      color: colors.background,
      symbolColor: colors.foreground,
      height: TITLE_BAR_HEIGHT,
    })
  })
  ipcMain.on('tnega:version', event => {
    if (isTrustedSender(event.senderFrame?.url ?? '')) event.returnValue = app.getVersion()
  })
  ipcMain.handle('tnega:update-state', event => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return undefined
    return updates?.state()
  })
  ipcMain.handle('tnega:update-check', async event => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return undefined
    return updates?.check()
  })
  ipcMain.handle('tnega:update-install', event => {
    if (!isTrustedSender(event.senderFrame?.url ?? '') || !updates?.ready()) return
    void closeAndExit({ restartIntoUpdate: true })
  })
  ipcMain.handle('tnega:update-channel', (event, channel: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '') || (channel !== 'stable' && channel !== 'preview')) return undefined
    return updates?.setChannel(channel)
  })
}

async function createWindow(): Promise<void> {
  // The renderer recolours the overlay once its theme is known; start from the OS theme.
  const initial = DEFAULT_TITLE_BAR_COLORS[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: initial.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: initial.background,
      symbolColor: initial.foreground,
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.js'),
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const iconDirectory = join(dirname(fileURLToPath(import.meta.url)), '../build')
  completion = installCompletionNotice(window, {
    completed: nativeImage.createFromPath(join(iconDirectory, 'completion-rain.png')),
    failed: nativeImage.createFromPath(join(iconDirectory, 'completion-storm.png')),
    waiting: nativeImage.createFromPath(join(iconDirectory, 'completion-snow.png')),
  }, () => shell.beep())
  browser = new DesktopBrowser(window, event => isTrustedSender(event.senderFrame?.url ?? ''))
  server = await startWebServer({ host: '127.0.0.1', port: 0, webRoot: webRoot(), browser: browser.host, profile: defaultHotProfile(), ptcRuntime: desktopPtcAssets(appRoot()) })
  allowedOrigin = new URL(server.url).origin
  tray = installTray(window, join(dirname(fileURLToPath(import.meta.url)), '../build/icon.png'), () => { void closeAndExit() })
  window.on('closed', () => {
    completion?.dispose()
    completion = undefined
    tray?.dispose()
    tray = undefined
  })
  window.maximize()
  await window.loadURL(server.url)
}

async function closeAndExit(options: { restartIntoUpdate?: boolean } = {}): Promise<void> {
  if (quitting) return
  quitting = true
  tray?.dispose()
  tray = undefined
  updates?.stop()
  await closeDesktopRuntime(server)
  server = undefined
  await browser?.dispose().catch(() => {})
  browser = undefined
  // A downloaded update installs on the way out; the update button also relaunches.
  if (options.restartIntoUpdate) updates?.install()
  else if (updates?.installOnExit()) return
  else app.exit(0)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  installDesktopHandlers()
  updates = createUpdates()
  await createWindow()
  updates.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
}).catch(error => {
  console.error(error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void closeAndExit()
})

app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  void closeAndExit()
})

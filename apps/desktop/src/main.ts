import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWebServer, type WebServer } from '@tnega/cli'
import { closeDesktopRuntime } from './shutdown.js'

let server: WebServer | undefined
let allowedOrigin = ''
let quitting = false

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

function isTrustedSender(senderUrl: string): boolean {
  try {
    return new URL(senderUrl).origin === allowedOrigin
  } catch {
    return false
  }
}

function installDesktopHandlers(): void {
  ipcMain.handle('tnega:pick-workspace', async event => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return undefined
    const result = await dialog.showOpenDialog({
      title: 'Choose a workspace',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle('tnega:reveal-workspace', async (event, path: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '') || typeof path !== 'string') return
    await shell.openPath(path)
  })
  ipcMain.on('tnega:version', event => {
    if (isTrustedSender(event.senderFrame?.url ?? '')) event.returnValue = app.getVersion()
  })
}

async function createWindow(): Promise<void> {
  server = await startWebServer({ host: '127.0.0.1', port: 0, webRoot: webRoot() })
  allowedOrigin = new URL(server.url).origin
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#faf9f6',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#222222',
      symbolColor: '#c7c7c7',
      height: 32,
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
  window.maximize()
  await window.loadURL(server.url)
}

async function closeAndExit(): Promise<void> {
  if (quitting) return
  quitting = true
  await closeDesktopRuntime(server)
  server = undefined
  app.exit(0)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  installDesktopHandlers()
  await createWindow()
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

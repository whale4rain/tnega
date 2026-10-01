// Run after building: pnpm --filter @tnega/desktop exec electron scripts/verify-chrome.cjs
// Hidden, disposable window with fixture APIs; never loads user data or credentials.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { readFile } = require('node:fs/promises')
const { join, extname } = require('node:path')

const webRoot = join(__dirname, '../../../dist/web')
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(pathname === '/api/config'
      ? { apiKeySet: false, models: [], config: {}, effective: {}, env: {} }
      : { workspaces: ['D:/demo/tnega'], sessions: [] }))
    return
  }
  try {
    const file = join(webRoot, pathname === '/' ? 'index.html' : pathname)
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch {
    res.writeHead(404)
    res.end()
  }
})

async function run() {
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({
    width: 1280, height: 820, show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { height: 32 },
    webPreferences: {
      partition: 'chrome-verification', contextIsolation: true,
      nodeIntegration: false, sandbox: true, offscreen: true,
      preload: join(__dirname, '../out/preload.js'),
    },
  })
  window.webContents.on('preload-error', (_event, _path, error) => console.error('Preload failed:', error.message))
  await window.loadURL(`http://127.0.0.1:${server.address().port}`)
  const bridge = await window.webContents.executeJavaScript(`typeof globalThis.tnegaDesktop?.setTitleBarColors`)
  assert.equal(bridge, 'function', 'sandboxed preload must expose the desktop bridge')
  for (let index = 0; index < 100; index += 1) {
    if (await window.webContents.executeJavaScript(`document.documentElement.classList.contains('desktop-chrome') && !!document.querySelector('.conv-header')`)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const layout = await window.webContents.executeJavaScript(`({
    padding: parseFloat(getComputedStyle(document.querySelector('#root')).paddingTop),
    headerTop: document.querySelector('.conv-header').getBoundingClientRect().top,
    drag: getComputedStyle(document.body, '::before').getPropertyValue('-webkit-app-region'),
    height: parseFloat(getComputedStyle(document.body, '::before').height),
  })`)
  assert.ok(layout.padding >= 32, JSON.stringify(layout))
  assert.ok(layout.headerTop >= 32, 'session controls must sit below native window buttons')
  assert.equal(layout.drag.trim(), 'drag', 'title bar must be draggable')
  assert.ok(layout.height >= 32)
  console.log('Sandboxed preload, title bar clearance and drag region passed:', layout)
  window.destroy()
  server.close()
  app.exit(0)
}
run().catch(error => { console.error(error); server.close(); app.exit(1) })

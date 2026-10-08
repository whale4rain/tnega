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
    if (await window.webContents.executeJavaScript(`!!document.querySelector('.conv-header.window-controls-header')`)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const layout = await window.webContents.executeJavaScript(`({
    padding: parseFloat(getComputedStyle(document.querySelector('#root')).paddingTop),
    headerTop: document.querySelector('.conv-header').getBoundingClientRect().top,
    actionsRight: document.querySelector('.conv-header-actions').getBoundingClientRect().right,
    width: innerWidth,
    drag: getComputedStyle(document.querySelector('.conv-header')).getPropertyValue('-webkit-app-region'),
    actionsDrag: getComputedStyle(document.querySelector('.conv-header-actions')).getPropertyValue('-webkit-app-region'),
  })`)
  assert.equal(layout.padding, 0, 'no extra title bar row')
  assert.equal(layout.headerTop, 0, 'keep original header position')
  assert.ok(layout.actionsRight <= layout.width - 138, `session controls must clear native window buttons: ${JSON.stringify(layout)}`)
  assert.equal(layout.drag.trim(), 'drag', 'title bar must be draggable')
  assert.equal(layout.actionsDrag.trim(), 'no-drag', 'controls must remain clickable')
  console.log('Sandboxed preload, title bar clearance and drag region passed:', layout)
  await window.webContents.executeJavaScript(`document.querySelector('button[aria-label^="Show workbench"]').click()`)
  for (let index = 0; index < 100; index += 1) {
    if (await window.webContents.executeJavaScript(`!!document.querySelector('.wb-header.window-controls-header')`)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const workbench = await window.webContents.executeJavaScript(`({
    closeRight: document.querySelector('button[aria-label="Close workbench"]').getBoundingClientRect().right,
    width: innerWidth,
    railDrag: getComputedStyle(document.querySelector('.wb-rail')).getPropertyValue('-webkit-app-region'),
    fillDrag: getComputedStyle(document.querySelector('.wb-rail-fill')).getPropertyValue('-webkit-app-region'),
  })`)
  assert.ok(workbench.closeRight <= workbench.width - 138, 'Workbench controls must clear native buttons')
  assert.equal(workbench.railDrag.trim(), 'no-drag', 'tab scrolling must not drag the window')
  assert.equal(workbench.fillDrag.trim(), 'drag', 'empty header space remains draggable')
  console.log('Workbench scroll region and native controls clearance passed:', workbench)
  window.destroy()
  server.close()
  app.exit(0)
}
run().catch(error => { console.error(error); server.close(); app.exit(1) })

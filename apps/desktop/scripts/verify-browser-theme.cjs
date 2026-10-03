// Run: pnpm --filter @tnega/desktop exec electron scripts/verify-browser-theme.cjs
// Isolated hidden Electron host; never opens the user's profile or changes OS settings.
const { app, BrowserWindow, WebContentsView, nativeTheme } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')

const directory = mkdtempSync(join(tmpdir(), 'tnega-browser-theme-'))
app.setPath('userData', directory)
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
const views = []
let window
let source
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function createTarget() {
  const view = new WebContentsView({ webPreferences: {
    partition: 'browser-theme-fixture', sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  views.push(view)
  await view.webContents.loadURL('data:text/html,<title>Browser fixture</title>')
  view.webContents.debugger.attach('1.3')
  const { targetInfo } = await view.webContents.debugger.sendCommand('Target.getTargetInfo')
  view.webContents.debugger.detach()
  return targetInfo.targetId
}

async function expectTheme(theme, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await window.webContents.executeJavaScript('document.documentElement.dataset.theme') === theme) return
    await pause(50)
  }
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.dataset.theme'), theme, message)
}

async function run() {
  await app.whenReady()
  nativeTheme.themeSource = 'dark'
  window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } })
  await window.loadURL(`data:text/html,${encodeURIComponent(`<script>
    window.preference = 'system';
    const media = matchMedia('(prefers-color-scheme: dark)');
    window.applyTheme = () => document.documentElement.dataset.theme =
      preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    media.addEventListener('change', applyTheme); applyTheme();
  </script>`)}`)
  await expectTheme('dark', 'fixture starts with the dark system theme')
  const target = await createTarget()
  const portFile = join(directory, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 50 && !existsSync(portFile); attempt += 1) await pause(100)
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
  const compiled = join(directory, 'browser-source.mjs')
  await require('esbuild').build({
    entryPoints: [join(__dirname, '../../../packages/browser/browser-playwright/src/source.ts')],
    outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    plugins: [{ name: 'host-playwright', setup(builder) {
      builder.onResolve({ filter: /^playwright-core$/ }, () => ({
        path: pathToFileURL(join(dirname(require.resolve('playwright-core/package.json')), 'index.mjs')).href,
        external: true,
      }))
    } }],
  })
  const { cdpPageSource } = await import(pathToFileURL(compiled).href)
  source = cdpPageSource({ endpoint: async () => `http://127.0.0.1:${port}`, targetId: async () => target, openTarget: createTarget })
  const page = await source.acquire()
  assert.equal(await page.title(), 'Browser fixture', 'only the embedded browser target is selected')
  await pause(100)
  await expectTheme('dark', 'attaching Browser must preserve the host system theme')
  await source.open()
  await expectTheme('dark', 'opening a Browser tab must preserve the host theme')
  for (const preference of ['light', 'dark', 'system']) {
    await window.webContents.executeJavaScript(`preference = ${JSON.stringify(preference)}; applyTheme()`)
    await source.release()
    await source.acquire()
    await expectTheme(preference === 'system' ? 'dark' : preference, 'reconnection preserves each theme preference')
  }
  nativeTheme.themeSource = 'light'
  await expectTheme('light', 'system theme still follows host changes after Browser attaches')
  console.log('Browser attach, new tabs, reconnect and all theme preferences passed')
}

run().then(() => finish(0), error => { console.error(error); void finish(1) })
async function finish(code) {
  await source?.release().catch(() => {})
  for (const view of views) view.webContents.close()
  window?.destroy()
  // Electron may briefly retain profile file handles; cleanup is best effort.
  try { rmSync(directory, { recursive: true, force: true }) } catch {
    // The OS can release Electron's profile handles after this process exits.
  }
  app.exit(code)
}

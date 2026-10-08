/* global process, console, fetch, localStorage, window, document */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { installFixtures, workspace, config as baseConfig, session } from './fixtures.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(web, 'e2e/.artifacts')
await mkdir(artifacts, { recursive: true })
const executablePath = process.env.TNEGA_E2E_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)
assert(executablePath && existsSync(executablePath), 'Set TNEGA_E2E_BROWSER to an installed Chrome or Edge executable.')
const port = await new Promise((resolvePort, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(() => resolvePort(address.port))
  })
})
const origin = `http://127.0.0.1:${port}`
const vite = spawn(process.execPath, [resolve(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let serverOutput = ''
vite.stdout.on('data', value => { serverOutput += value })
vite.stderr.on('data', value => { serverOutput += value })
let browser
let activePage
const results = []
async function check(name, action) {
  await action()
  results.push(name)
  console.log(`PASS ${name}`)
}
async function waitFor(condition, label) {
  for (let index = 0; index < 100; index++) {
    if (await condition()) return
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }))
  assert(dimensions.scroll <= dimensions.width + 1, `Horizontal overflow: ${JSON.stringify(dimensions)}`)
}
try {
  await waitFor(async () => { if (vite.exitCode !== null) throw new Error(serverOutput); try { return (await fetch(origin)).ok } catch { return false } }, 'Vite startup')
  browser = await chromium.launch({ executablePath, headless: true })
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    const fixtures = await installFixtures(context)
    let config = { ...baseConfig, effective: { baseUrl: 'https://gateway.example/v1', model: 'official', modelId: 'official' },
      config: { ...baseConfig.config, models: [{ id: 'official', model: 'official', name: 'Official model', protocol: 'openai', apiKeySet: true, source: 'provider' }] },
      models: [{ id: 'official', name: 'Official model', protocol: 'openai', reasoningEfforts: ['high'], apiKeySet: true, source: 'provider' },
        { id: 'proxy', name: 'Proxy model', protocol: 'openai', reasoningEfforts: [], apiKeySet: true, source: 'third-party' }] }
    let discovery = 'normal'
    const saved = []
    const discoveries = []
    let sessionPatch
    await context.route('**/api/config**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (path === '/api/config' && request.method() === 'GET') return json(config)
      if (path === '/api/config/models/discover') {
        const body = request.postDataJSON()
        discoveries.push(body)
        assert.equal(Object.hasOwn(body, 'apiKey'), false, 'Saved connections never send their API key')
        if (body.auth === 'chatgpt') return json({ error: 'Sign in to ChatGPT first' }, 401)
        if (discovery === 'empty') return json({ models: [], source: 'provider' })
        return json({ source: 'provider', models: [{ id: 'official', name: 'Official model' }, { id: 'fresh', name: 'Fresh model', contextWindow: 128000, vision: true }, { id: 'project-new', name: 'Project model' }] })
      }
      if (path.startsWith('/api/config/models/') && request.method() === 'PUT') {
        const body = request.postDataJSON()
        const id = decodeURIComponent(path.split('/').at(-1))
        saved.push({ id, ...body })
        config = { ...config, models: [...config.models, { id, name: body.name || body.model, protocol: 'openai', apiKeySet: true, reasoningEfforts: [], source: body.source || 'provider' }],
          config: { ...config.config, models: [...config.config.models, { ...body, id, apiKeySet: true }] } }
        return json(config)
      }
      return route.fallback()
    })
    await context.route('**/api/auth/chatgpt', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'signed-out' }) }))
    await context.route('**/api/sessions/session-fixture?**', route => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      sessionPatch = route.request().postDataJSON()
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ summary: { ...session, ...sessionPatch } }) })
    })
    await context.addInitScript(({ workspace, theme }) => { localStorage.setItem('tnega.workspace', workspace); localStorage.setItem('tnega.theme', theme); localStorage.setItem('tnega.mode', 'sessions') }, { workspace, theme })
    const errors = []
    const page = await context.newPage()
    activePage = page
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(10000)
    await page.goto(`${origin}/#session-fixture`)
    await page.locator('.agent-body').getByText('Done. See', { exact: false }).waitFor()
    const input = page.getByPlaceholder('Reply… (/ for commands, @ for files)')
    await input.fill('Keep this unsent draft')
    await check(`${theme}: Session menu groups sources and adds a discovered model`, async () => {
      await page.getByRole('button', { name: /^Model:/ }).click()
      await page.getByRole('group', { name: 'Model providers', exact: true }).waitFor()
      await page.getByRole('group', { name: 'Third-party', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Add model…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add model', exact: true })
      await dialog.getByRole('button', { name: 'Get models' }).click()
      assert.equal(await dialog.getByRole('button', { name: 'Already added' }).isDisabled(), true)
      await dialog.getByLabel('Search models').fill('Fresh')
      assert.equal(await dialog.getByRole('button', { name: 'Add Project model' }).count(), 0)
      await page.screenshot({ path: resolve(artifacts, `models-${theme}.png`), fullPage: true })
      await dialog.getByRole('button', { name: 'Add Fresh model' }).click()
      await page.getByRole('button', { name: 'Model: Fresh model', exact: true }).waitFor()
      assert.equal(await input.inputValue(), 'Keep this unsent draft')
      assert.equal(sessionPatch.model, 'fresh')
      assert.deepEqual(saved[0], { id: 'fresh', model: 'fresh', name: 'Fresh model', source: 'provider', sourceRouteId: 'official', contextWindow: 128000, vision: true })
      await noOverflow(page)
    })
    await check(`${theme}: empty results and unsigned ChatGPT retain manual fallback`, async () => {
      await page.getByRole('button', { name: /^Model:/ }).click()
      await page.getByRole('button', { name: 'Add model…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add model', exact: true })
      discovery = 'empty'
      await dialog.getByRole('button', { name: 'Get models' }).click()
      await dialog.getByRole('status').getByText(/returned no models/).waitFor()
      await dialog.getByLabel('Connection').selectOption('chatgpt')
      await dialog.getByRole('button', { name: 'Get models', exact: true }).click()
      await dialog.getByRole('alert').getByText('Sign in to ChatGPT first').waitFor()
      await dialog.getByRole('button', { name: 'Enter model manually' }).click()
      await dialog.getByPlaceholder('deepseek-chat').waitFor()
      assert.equal(await dialog.getByLabel('API key', { exact: true }).count(), 0)
      await dialog.getByText(/Uses your ChatGPT login/).waitFor()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.getByLabel('Connection').selectOption('openai')
      await dialog.getByRole('button', { name: 'Get models', exact: true }).click()
      await dialog.getByRole('status').getByText(/returned no models/).waitFor()
      assert.deepEqual(discoveries.at(-1), { protocol: 'openai', baseUrl: 'https://api.openai.com/v1' })
      await dialog.getByRole('button', { name: 'Enter model manually' }).click()
      await dialog.getByLabel('API key', { exact: true }).fill('fixture-manual-key')
      await dialog.getByPlaceholder('deepseek-chat').fill('manual-api')
      await dialog.getByRole('button', { name: 'Add model', exact: true }).click()
      await page.getByRole('button', { name: 'Model: manual-api', exact: true }).waitFor()
      assert.equal(saved[1].apiKey, 'fixture-manual-key')
      assert.equal(saved[1].baseUrl, 'https://api.openai.com/v1')
      assert.equal(Object.hasOwn(saved[1], 'auth'), false)
      assert.equal(await input.inputValue(), 'Keep this unsent draft')
      discovery = 'normal'
    })
    await check(`${theme}: Project role picker adds and selects a model`, async () => {
      await page.goto(`${origin}/#p/project`)
      await page.getByTitle('Project settings: instructions, memory, models', { exact: true }).click()
      await page.getByRole('button', { name: /^Coordinator model:/ }).click()
      await page.getByRole('button', { name: 'Add model…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add model', exact: true })
      await dialog.getByRole('button', { name: 'Get models' }).click()
      await dialog.getByRole('button', { name: 'Add Project model' }).click()
      await page.getByRole('button', { name: 'Coordinator model: Project model', exact: true }).waitFor()
      await page.getByRole('button', { name: /^Threads model:/ }).click()
      await page.getByRole('option', { name: /Project model/ }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Add model…' }).isVisible(), true)
      await noOverflow(page)
      await page.screenshot({ path: resolve(artifacts, `project-models-${theme}.png`), fullPage: true })
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(fixtures.unexpected, [])
    await context.close()
  }
  console.log(`\n${results.length} checks passed. Screenshots: ${artifacts}`)
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(artifacts, 'models-failure.png'), fullPage: true }).catch(() => {})
    console.error(await activePage.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally { await browser?.close(); vite.kill() }

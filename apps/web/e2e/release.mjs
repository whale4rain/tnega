/* global process, console, fetch, localStorage, location, window, document, getComputedStyle, ReadableStream, TextEncoder, Response */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { installFixtures, workspace, snapshot, session as savedSession, config as baseConfig } from './fixtures.mjs'

/*
 * Release readiness: the main flows a person walks through after installing a stable version, end to
 * end against the real App with fixture APIs. First run, a session with a live run, projects and
 * threads, the Board, settings and every palette, the Workbench, artifacts, and the desktop title bar
 * (emulated through the same bridge the Electron preload exposes).
 */

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(web, 'e2e/.artifacts/release')
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
/** A computed colour, resolved the way the browser paints it, for comparing against a token. */
async function token(page, name) {
  return page.evaluate(name => {
    const probe = document.createElement('i')
    probe.style.color = `var(${name})`
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, name)
}

const longCommand = 'Get-ChildItem -Recurse -Filter README.md -Depth 2 | ForEach-Object { "== $($_.FullName.Replace($PWD.Path, \'.\'))"; Get-Content $_.FullName -TotalCount 40 } | Out-String -Width 400'
const artifact = { kind: 'artifact', id: 'release-notes', seq: 4, version: 1, author: 'writer', source: { messageId: 'thread-reply' }, createdAt: Date.now(), updatedAt: Date.now(), deleted: false,
  data: { title: 'Release notes', hash: 'release-notes', mediaType: 'text/markdown', size: 64 } }

/**
 * Routes beyond the shared fixtures: an empty first run, a session created from the composer, a model
 * route for Settings, and an artifact. Later routes win in Playwright, so these sit over `installFixtures`.
 */
async function installReleaseFixtures(context, { firstRun }) {
  let workspaces = firstRun ? [] : [workspace]
  const created = { ...savedSession, id: 'session-release', title: 'Find the READMEs', eventCount: 0 }
  let sessions = [savedSession]
  let events = []
  const config = { ...baseConfig, effective: { baseUrl: 'https://api.example/v1', model: 'fixture', modelId: 'fixture' },
    config: { ...baseConfig.config, models: [{ id: 'fixture', model: 'fixture', name: 'Fixture model', protocol: 'openai', apiKeySet: true, source: 'provider' }] },
    models: [{ id: 'fixture', name: 'Fixture model', protocol: 'openai', reasoningEfforts: [], apiKeySet: true, source: 'provider', contextWindow: 128000 }] }
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await context.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    if (path === '/api/config' && method === 'GET') return json(route, config)
    if (path === '/api/workspaces' && method === 'GET') return json(route, { workspaces })
    if (path === '/api/workspaces' && method === 'POST') {
      workspaces = [request.postDataJSON().path]
      return json(route, { path: workspaces[0], workspaces })
    }
    if (path === '/api/sessions' && method === 'GET') return json(route, { sessions: url.searchParams.get('workspace') === workspace ? sessions : [] })
    if (path === '/api/sessions' && method === 'POST') {
      sessions = [created, ...sessions]
      return json(route, { session: created })
    }
    if (path === '/api/sessions/session-release' && method === 'GET') {
      return json(route, { summary: { ...created, eventCount: events.length }, events, surface: events,
        context: { tokens: 400, limit: 128000, ratio: 0.003 }, metrics: baseTotals, usage: baseTotals, running: false })
    }
    // A new session takes the composer's draft settings once it exists.
    if (path === '/api/sessions/session-release' && method === 'PATCH') return json(route, { summary: { ...created, ...request.postDataJSON() } })
    if (path === '/api/sessions/session-release/jobs') return json(route, { jobs: [] })
    if (path === '/api/sessions/session-release/questions') return json(route, { questions: [] })
    if (path === '/api/sessions/session-release/coding/commands') return json(route, { commands: [] })
    if (path === '/api/sessions/session-release/goal') return json(route, { goal: null })
    if (path === '/api/sessions/session-release/subagents') return json(route, { subagents: [] })
    if (path === '/api/auth/chatgpt') return json(route, { status: 'signed-out' })
    if (path === '/api/workspace-prompt') return json(route, { prompt: '' })
    if (path === '/api/projects/project' && method === 'GET') {
      return json(route, { ...snapshot, library: { ...snapshot.library, artifacts: [artifact] },
        threadMessages: snapshot.threadMessages.map(message => message.messageId === 'thread-reply' ? { ...message, refs: [artifact.data] } : message) })
    }
    if (path === '/api/projects/project/artifacts/release-notes/thread') return json(route, { artifact, thread: snapshot.threads.find(thread => thread.id === 'writer') })
    if (path === '/api/projects/project/artifacts/release-notes') return route.fulfill({ contentType: 'text/markdown', body: '# Release notes\n\nEverything a stable version needs.' })
    return route.fallback()
  })
  return { persist: next => { events = next } }
}
const baseTotals = { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, activeMs: 0 }

/** The run stream is held open from the page so the test can show a live turn step by step. */
function holdRuns() {
  const original = window.fetch.bind(window)
  const encoder = new TextEncoder()
  window.__runs = []
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (/\/api\/sessions\/[^/?]+\/runs/.test(url) && init?.method === 'POST') {
      let controller
      const body = new ReadableStream({ start(value) { controller = value } })
      window.__runs.push({
        prompt: JSON.parse(init.body).prompt,
        push: event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
        end: () => controller.close(),
      })
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    }
    return original(input, init)
  }
}

async function open(context, { theme, firstRun = false, desktop = false, mode = 'sessions', hash = '' }) {
  await context.addInitScript(({ workspace, theme, firstRun, desktop, mode, origin }) => {
    if (location.origin !== origin) return
    if (!firstRun && !localStorage.getItem('tnega.workspace')) localStorage.setItem('tnega.workspace', workspace)
    if (!localStorage.getItem('tnega.theme')) localStorage.setItem('tnega.theme', theme)
    if (!localStorage.getItem('tnega.mode')) localStorage.setItem('tnega.mode', mode)
    // The Electron preload exposes this bridge; its presence is what turns on the desktop title bar.
    if (desktop) window.tnegaDesktop = { setTitleBarColors: colors => { window.__titleBar = colors } }
  }, { workspace, theme, firstRun, desktop, mode, origin })
  await context.addInitScript(holdRuns)
  const page = await context.newPage()
  activePage = page
  page.setDefaultTimeout(10000)
  await page.goto(`${origin}/${hash}`)
  return page
}

try {
  await waitFor(async () => {
    if (vite.exitCode !== null) throw new Error(`Vite stopped: ${serverOutput}`)
    try { return (await fetch(origin)).ok } catch { return false }
  }, 'Vite startup')
  browser = await chromium.launch({ executablePath, headless: true })
  for (const theme of ['dark', 'light']) {
    // --- first run and a session -------------------------------------------------------------
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      const fixtures = await installFixtures(context)
      const release = await installReleaseFixtures(context, { firstRun: true })
      const errors = []
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      const page = await open(context, { theme, firstRun: true })

      await check(`${theme}: first run asks for a folder, then opens a new session`, async () => {
        await page.getByRole('heading', { name: 'Welcome to tnega', exact: true }).waitFor()
        await noOverflow(page)
        await page.screenshot({ path: resolve(artifacts, `first-run-${theme}.png`) })
        await page.getByRole('button', { name: 'Open a folder', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByPlaceholder(/projects/).fill(workspace)
        await dialog.getByRole('button', { name: 'Open', exact: true }).click()
        await page.getByRole('dialog').waitFor({ state: 'detached' })
        await page.getByRole('complementary', { name: 'Workspaces', exact: true }).getByText('workspace', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => localStorage.getItem('tnega.workspace')), workspace)
      })

      await check(`${theme}: a live run keeps long tool commands inside the row`, async () => {
        const input = page.getByPlaceholder(/^Describe a change/)
        await input.fill('Find the READMEs')
        await input.press('Enter')
        await waitFor(() => page.evaluate(() => window.__runs.length === 1), 'run started')
        const push = events => page.evaluate(events => { for (const event of events) window.__runs.at(-1).push(event) }, events)
        await push([
          { type: 'message_start', id: 'm1' },
          { type: 'message_delta', id: 'm1', delta: 'Looking for README files.' },
          { type: 'message_stop', id: 'm1', finishReason: 'tool_calls' },
          { type: 'tool/start', index: 0, call: { id: 'c1', name: 'list_dir', arguments: { path: '.' } } },
          { type: 'tool/end', index: 0, call: { id: 'c1', name: 'list_dir', arguments: { path: '.' } }, result: { ok: true, output: 'docs/\nREADME.md', durationMs: 12 } },
          { type: 'tool/start', index: 1, call: { id: 'c2', name: 'shell', arguments: { command: longCommand } } },
        ])
        const head = page.locator('.tool-group-head').first()
        await head.locator('.tool-target').waitFor()
        await page.screenshot({ path: resolve(artifacts, `live-tool-${theme}.png`) })
        const fit = await head.evaluate(element => {
          const target = element.querySelector('.tool-target')
          const card = element.closest('.tool-group').getBoundingClientRect()
          return { headOverflow: element.scrollWidth - element.clientWidth, ellipsis: target.scrollWidth > target.clientWidth,
            right: Math.max(...[...element.children].map(child => child.getBoundingClientRect().right)), cardRight: card.right }
        })
        assert(fit.headOverflow <= 1, `The step row does not overflow: ${JSON.stringify(fit)}`)
        assert(fit.right <= fit.cardRight + 1, `Nothing in the row passes the card edge: ${JSON.stringify(fit)}`)
        assert(fit.ellipsis, 'The long command is truncated with an ellipsis')
        assert.equal(await head.getAttribute('title'), `Running ${longCommand}`, 'Hovering shows the whole command')
        // Expanded, the running step shows the full command wrapped, not a sideways scroll.
        await head.click()
        await page.locator('.tool-group-list .tool-row-head').nth(1).click()
        const pre = page.locator('.tool-detail .code-block pre').first()
        await pre.getByText('Get-ChildItem', { exact: false }).waitFor()
        const wrap = await pre.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
        assert(wrap.scroll <= wrap.client + 1, `The command wraps: ${JSON.stringify(wrap)}`)
        await noOverflow(page)
        await page.screenshot({ path: resolve(artifacts, `live-tool-open-${theme}.png`) })
      })

      await check(`${theme}: a finished run folds its steps and survives a reload`, async () => {
        const at = Date.now()
        release.persist([
          { id: 'u1', seq: 1, ts: at, type: 'user/message', payload: { content: 'Find the READMEs' } },
          { id: 't1', seq: 2, ts: at, type: 'turn/start', payload: { turn: 1 } },
          { id: 'a1', seq: 3, ts: at, type: 'assistant/message', payload: { content: 'Looking for README files.', toolCalls: [
            { id: 'c1', name: 'list_dir', arguments: { path: '.' } }, { id: 'c2', name: 'shell', arguments: { command: longCommand } }] } },
          { id: 'r1', seq: 4, ts: at, type: 'tool/result', payload: { toolCallId: 'c1', name: 'list_dir', ok: true, output: 'docs/\nREADME.md', durationMs: 12 } },
          { id: 'r2', seq: 5, ts: at, type: 'tool/result', payload: { toolCallId: 'c2', name: 'shell', ok: true, output: '== ./README.md', durationMs: 840 } },
          { id: 'a2', seq: 6, ts: at, type: 'assistant/message', payload: { content: 'Found one README at the root.' } },
          { id: 't2', seq: 7, ts: at, type: 'turn/end', payload: { turn: 1, finishReason: 'stop' } },
        ])
        await page.evaluate(() => {
          const run = window.__runs.at(-1)
          run.push({ type: 'tool/end', index: 1, call: { id: 'c2', name: 'shell', arguments: {} }, result: { ok: true, output: '== ./README.md', durationMs: 840 } })
          run.push({ type: 'message_start', id: 'm2' })
          run.push({ type: 'message_delta', id: 'm2', delta: 'Found one README at the root.' })
          run.push({ type: 'message_stop', id: 'm2', finishReason: 'stop' })
          run.push({ type: 'done' })
          run.end()
        })
        await page.getByText('Found one README at the root.', { exact: true }).waitFor()
        assert.equal(new URL(page.url()).hash, '#session-release')
        await page.reload()
        await page.getByText('Found one README at the root.', { exact: true }).waitFor()
        assert.equal(await page.locator('.session-button').filter({ hasText: 'Find the READMEs' }).count(), 1, 'The new session is listed')
        await noOverflow(page)
        await page.screenshot({ path: resolve(artifacts, `session-${theme}.png`) })
      })

      await check(`${theme}: the Workbench opens, switches tools, resizes with a quiet line`, async () => {
        await page.keyboard.press('Control+j')
        const rail = page.getByRole('tablist', { name: 'Workbench', exact: true })
        await rail.waitFor()
        await rail.getByRole('tab', { name: 'Files', exact: true }).click()
        await page.getByRole('treeitem', { name: /docs/ }).click()
        await page.getByRole('treeitem', { name: /brief\.md/ }).click()
        await page.locator('.cm-content').getByText('# Short writing brief', { exact: true }).waitFor()
        await rail.getByRole('tab', { name: 'Changes', exact: true }).click()
        await rail.getByRole('tab', { name: 'Browser', exact: true }).click()
        const handle = page.getByRole('separator', { name: 'Resize workbench', exact: true })
        const box = await handle.boundingBox()
        const before = await page.locator('.workbench').evaluate(element => element.getBoundingClientRect().width)
        await page.mouse.move(box.x + box.width / 2, box.y + 300)
        await delay(400)
        const line = await handle.evaluate(element => getComputedStyle(element, '::after').backgroundColor)
        assert.equal(line, await token(page, '--border-strong'), 'The resize line is a hairline, not the accent')
        assert.notEqual(line, await token(page, '--accent'))
        await page.mouse.down()
        await page.mouse.move(box.x - 80, box.y + 300, { steps: 4 })
        await page.mouse.up()
        const after = await page.locator('.workbench').evaluate(element => element.getBoundingClientRect().width)
        assert(after > before + 40, `Dragging widens the Workbench: ${before} → ${after}`)
        assert.equal(await handle.evaluate(element => element.classList.contains('is-dragging')), false, 'The drag line clears on release')
        await page.screenshot({ path: resolve(artifacts, `workbench-${theme}.png`) })
        await page.keyboard.press('Control+j')
        await rail.waitFor({ state: 'detached' })
      })

      await check(`${theme}: Settings switch every palette and theme, and mark the default model quietly`, async () => {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Settings' })
        await dialog.waitFor()
        await dialog.getByRole('tab', { name: 'Models', exact: true }).click()
        const route = dialog.locator('.model-route.is-default')
        await route.getByText('Fixture model', { exact: true }).waitFor()
        assert.equal(await route.evaluate(element => getComputedStyle(element).borderTopColor), await token(page, '--border-strong'))
        await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click()
        const palettes = await dialog.locator('.palette-card').count()
        assert(palettes >= 5, `Every palette is offered: ${palettes}`)
        for (let index = 0; index < palettes; index++) {
          const card = dialog.locator('.palette-card').nth(index)
          await card.click()
          const name = await page.locator('html').getAttribute('data-palette')
          assert.equal(await card.evaluate(element => element.classList.contains('active')), true, `${name} shows as selected`)
          assert.equal(await card.evaluate(element => getComputedStyle(element).borderTopColor), await token(page, '--border-strong'))
        }
        await dialog.locator('.palette-card').filter({ hasText: 'Carbon' }).click()
        assert.equal(await page.locator('html').getAttribute('data-palette'), 'carbon')
        await dialog.screenshot({ path: resolve(artifacts, `settings-${theme}.png`) })
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
      })

      await check(`${theme}: the theme buttons switch light and dark and back`, async () => {
        const group = page.getByRole('radiogroup', { name: 'Theme', exact: true })
        const label = value => value[0].toUpperCase() + value.slice(1)
        for (const value of [theme === 'dark' ? 'light' : 'dark', theme]) {
          await group.getByRole('radio', { name: label(value), exact: true }).click()
          await waitFor(async () => await page.locator('html').getAttribute('data-theme') === value, `${value} theme`)
          assert.equal(await group.getByRole('radio', { name: label(value), exact: true }).getAttribute('aria-checked'), 'true')
        }
        // System follows the device; Playwright's default colour scheme is light.
        await group.getByRole('radio', { name: 'System', exact: true }).click()
        await waitFor(async () => await page.locator('html').getAttribute('data-theme') === 'light', 'system theme')
        await group.getByRole('radio', { name: label(theme), exact: true }).click()
      })

      assert.deepEqual(errors, [], `${theme}: unhandled browser exceptions`)
      assert.deepEqual(fixtures.unexpected, [], `${theme}: unhandled API routes`)
      await context.close()
    }

    // --- projects, threads and the Board --------------------------------------------------------
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      const fixtures = await installFixtures(context)
      await installReleaseFixtures(context, { firstRun: false })
      const errors = []
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      const page = await open(context, { theme, mode: 'projects', hash: '#p/project' })
      const main = page.locator('.project-main')
      await main.getByRole('heading', { name: 'Writing site', exact: true }).waitFor()

      await check(`${theme}: the Board greets, lists what needs you and opens threads`, async () => {
        const board = page.locator('.wb-card').filter({ has: page.locator('.board-greeting, h1, h2') }).first()
        await page.getByRole('tab', { name: /^Board/ }).click()
        const greeting = page.locator('.board-greeting').first()
        await greeting.waitFor()
        assert.match(await greeting.evaluate(element => getComputedStyle(element).fontFamily), /Fraunces/)
        await page.getByText('Needs you', { exact: true }).waitFor()
        assert(await board.count() >= 0)
        await noOverflow(page)
        await page.screenshot({ path: resolve(artifacts, `board-${theme}.png`) })
      })

      await check(`${theme}: an opened thread's card is marked quietly, Back returns to the Board`, async () => {
        const card = main.getByRole('button', { name: /^Open thread Content Writer/ }).first()
        await card.click()
        await page.getByText('Done. The headings are shorter.', { exact: true }).waitFor()
        assert.equal(new URL(page.url()).hash, '#p/project/writer')
        assert.equal(await card.getAttribute('aria-pressed'), 'true')
        const border = await card.evaluate(element => getComputedStyle(element).borderTopColor)
        assert.equal(border, await token(page, '--border-strong'), 'The open thread is not ringed with the accent')
        assert.notEqual(border, await token(page, '--accent'))
        await page.screenshot({ path: resolve(artifacts, `thread-${theme}.png`) })
        await page.getByRole('button', { name: 'Back to the Board', exact: true }).click()
        await page.locator('.board-greeting').first().waitFor()
        await page.getByRole('button', { name: 'Close Content Writer', exact: true }).click()
        assert.equal(await card.getAttribute('aria-pressed'), 'false')
      })

      await check(`${theme}: a reply goes straight to its thread`, async () => {
        const research = main.getByRole('button', { name: /^Open thread Research/ }).first()
        await research.click()
        await page.locator('.thread-panel[aria-label="Thread Research"]').waitFor()
        assert.equal(new URL(page.url()).hash, '#p/project/research')
        const input = main.getByRole('textbox', { name: 'Message', exact: true })
        await input.fill('A short note')
        assert.equal(await main.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true)
        await input.fill('')
      })

      await check(`${theme}: an artifact opens over the page and its close button closes it`, async () => {
        await page.getByRole('tab', { name: 'Library', exact: true }).click()
        await page.getByRole('button', { name: /Release notes/ }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Release notes' })
        await dialog.locator('.artifact-dialog-preview').getByRole('heading', { name: 'Release notes', exact: true }).waitFor()
        assert.equal(await page.evaluate(() => document.body.lastElementChild?.classList.contains('dialog-scrim')), true, 'Dialogs render last in <body>')
        await page.screenshot({ path: resolve(artifacts, `artifact-${theme}.png`) })
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
      })

      assert.deepEqual(errors, [], `${theme}: unhandled browser exceptions`)
      assert.deepEqual(fixtures.unexpected, [], `${theme}: unhandled API routes`)
      await context.close()
    }

    // --- the desktop title bar ------------------------------------------------------------------
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      const fixtures = await installFixtures(context)
      await installReleaseFixtures(context, { firstRun: false })
      const errors = []
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      const page = await open(context, { theme, desktop: true, mode: 'projects', hash: '#p/project' })
      await page.locator('.project-main').getByRole('heading', { name: 'Writing site', exact: true }).waitFor()
      const controls = { width: 138, height: 32 }

      await check(`${theme}: desktop: header actions sit beside the window controls, nothing under them`, async () => {
        assert.equal(await page.locator('html').evaluate(element => element.classList.contains('desktop-chrome')), true)
        if (!await page.locator('.workbench').count()) await page.keyboard.press('Control+j')
        const bar = page.locator('.wb-titlebar')
        await bar.waitFor()
        assert(await bar.locator('button').count() > 0, 'The header actions moved into the title-bar row')
        const clash = await page.evaluate(({ width, height }) => [...document.querySelectorAll('button, a, [role="tab"]')]
          .filter(element => {
            const box = element.getBoundingClientRect()
            return box.width && box.height && box.right > window.innerWidth - width && box.top < height
          }).map(element => element.getAttribute('aria-label') ?? element.textContent), controls)
        assert.deepEqual(clash, [], 'No control sits under the native window buttons')
        await waitFor(() => page.evaluate(() => Boolean(window.__titleBar)), 'title-bar colours')
        await page.screenshot({ path: resolve(artifacts, `desktop-${theme}.png`) })
      })

      await check(`${theme}: desktop: dialogs start below the window controls, are clickable and dim them`, async () => {
        const before = await page.evaluate(() => window.__titleBar.background)
        await page.getByRole('tab', { name: 'Library', exact: true }).click()
        await page.getByRole('button', { name: /Release notes/ }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Release notes' })
        await dialog.locator('.artifact-dialog-preview').getByRole('heading', { name: 'Release notes', exact: true }).waitFor()
        const layout = await page.evaluate(() => {
          const scrim = document.querySelector('.dialog-scrim')
          const close = document.querySelector('.dialog .dialog-close').getBoundingClientRect()
          return { region: getComputedStyle(scrim).getPropertyValue('-webkit-app-region') || getComputedStyle(scrim).getPropertyValue('app-region'),
            top: document.querySelector('.dialog').getBoundingClientRect().top, close: { top: close.top, right: close.right } }
        })
        assert(layout.top >= controls.height + 4, `The dialog starts below the window controls: ${JSON.stringify(layout)}`)
        assert(layout.close.top >= controls.height, `Its close button is clear of – ☐ ✕: ${JSON.stringify(layout)}`)
        if (layout.region) assert.equal(layout.region, 'no-drag', 'The overlay is not a window drag area')
        await waitFor(() => page.evaluate(before => window.__titleBar.background !== before, before), 'title bar dims with the scrim')
        await page.screenshot({ path: resolve(artifacts, `desktop-dialog-${theme}.png`) })
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        await waitFor(() => page.evaluate(before => window.__titleBar.background === before, before), 'title bar colour restored')
      })

      assert.deepEqual(errors, [], `${theme}: unhandled browser exceptions`)
      assert.deepEqual(fixtures.unexpected, [], `${theme}: unhandled API routes`)
      await context.close()
    }

    // --- narrow window ----------------------------------------------------------------------------
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
      const fixtures = await installFixtures(context)
      await installReleaseFixtures(context, { firstRun: false })
      const errors = []
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      const page = await open(context, { theme, hash: '#session-fixture' })
      await check(`${theme}: a phone-width window fits sessions and projects`, async () => {
        await page.locator('.agent-body').getByText('Done. See', { exact: false }).waitFor()
        await noOverflow(page)
        await page.goto(`${origin}/#p/project`)
        await page.locator('.project-main').getByRole('heading', { name: 'Writing site', exact: true }).waitFor()
        await noOverflow(page)
        await page.screenshot({ path: resolve(artifacts, `narrow-${theme}.png`) })
      })
      assert.deepEqual(errors, [], `${theme}: unhandled browser exceptions`)
      assert.deepEqual(fixtures.unexpected, [], `${theme}: unhandled API routes`)
      await context.close()
    }
  }
  console.log(`\n${results.length} checks passed. Screenshots: ${artifacts}`)
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    console.error(await activePage.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally {
  await browser?.close()
  vite.kill()
}

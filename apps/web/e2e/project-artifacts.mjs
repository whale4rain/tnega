/* global process, console, fetch, localStorage, location, window, document, Event */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { installFixtures, snapshot, workspace } from './fixtures.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(web, 'e2e/.artifacts')
await mkdir(artifacts, { recursive: true })
const executablePath = process.env.TNEGA_E2E_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
assert(executablePath, 'Set TNEGA_E2E_BROWSER to an installed browser.')
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
let output = ''
vite.stdout.on('data', value => { output += value })
vite.stderr.on('data', value => { output += value })
let browser
let page
try {
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (vite.exitCode !== null) throw new Error(output)
    try { ready = (await fetch(origin)).ok } catch { /* Starting. */ }
    if (!ready) await delay(100)
  }
  assert(ready, 'Vite startup timed out')
  browser = await chromium.launch({ executablePath, headless: true })
  for (const theme of ['light', 'dark']) for (const palette of ['sky', 'sand']) {
    const large = palette === 'sand'
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    const fixtures = await installFixtures(context)
    const errors = []
    const artifact = { kind: 'artifact', id: 'snapshot-report', seq: 1, version: 1, author: 'writer', source: { messageId: 'thread-reply' }, createdAt: Date.now(), updatedAt: Date.now(), deleted: false,
      data: { title: 'Writing report', hash: 'snapshot-report', mediaType: 'text/markdown', size: 90 } }
    const memory = { ...artifact, kind: 'memory', id: 'writing-rule', data: { text: 'Use short headings.', tags: ['writing'] } }
    let latest = memory
    const edits = []
    const artifactMessages = []
    await context.route('**/api/projects/project**', async route => {
      const path = new URL(route.request().url()).pathname
      const method = route.request().method()
      const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      if (path === '/api/projects/project' && method === 'GET') return json({ ...snapshot, memory: [memory], library: { ...snapshot.library, artifacts: [artifact] },
        threadMessages: snapshot.threadMessages.map(message => message.messageId === 'thread-reply' ? { ...message, refs: [artifact.data] } : message) })
      if (path === '/api/projects/project/artifacts/snapshot-report/thread') return json({ artifact, thread: snapshot.threads.find(thread => thread.id === 'writer') })
      if (path === '/api/projects/project/artifacts/snapshot-report/messages') {
        artifactMessages.push(route.request().postDataJSON())
        return json({ messageId: `artifact-message-${artifactMessages.length}`, createdAt: Date.now() })
      }
      if (path === '/api/projects/project/artifacts/snapshot-report') return route.fulfill({ contentType: 'text/markdown', body: '# Snapshot report\n\nThe original published report stays unchanged when workspace files change.\n\n- Short headings\n- Clear examples' })
      if (path === '/api/projects/project/memory/writing-rule' && method === 'GET') return json({ history: latest.version === 1 ? [memory] : [memory, latest] })
      if (path === '/api/projects/project/memory/writing-rule' && method === 'PATCH') {
        edits.push(route.request().postDataJSON())
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Memory changed concurrently' }) })
      }
      return route.fallback()
    })
    await context.addInitScript(({ workspace, theme, palette, large, origin }) => {
      if (location.origin !== origin) return
      localStorage.setItem('tnega.workspace', workspace)
      localStorage.setItem('tnega.theme', theme)
      localStorage.setItem('tnega.palette', palette)
      localStorage.setItem('tnega.density', large ? 'comfortable' : 'compact')
      localStorage.setItem('tnega.textSize', large ? 'large' : 'default')
      localStorage.setItem('tnega.mode', 'projects')
    }, { workspace, theme, palette, large, origin })
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(10000)
    await page.goto(`${origin}/#p/project`)
    await page.getByRole('tab', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'Open source message', exact: true }).waitFor()
    await page.screenshot({ path: resolve(artifacts, `artifact-library-${theme}-${palette}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Open source message', exact: true }).click()
    const source = page.locator('#msg-thread-reply')
    await source.waitFor()
    assert((await source.getAttribute('class')).includes('flash'), 'Library highlights the actual attachment message')
    assert.equal(new URL(page.url()).hash, '#p/project/writer')
    await page.screenshot({ path: resolve(artifacts, `artifact-source-${theme}-${palette}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Writing report Doc', exact: false }).click()
    await page.getByRole('heading', { name: 'Snapshot report', exact: true }).waitFor()
    const dialog = page.getByRole('dialog')
    assert.equal(await dialog.count(), 1)
    await dialog.getByPlaceholder('Message Content Writer…').waitFor()
    assert.equal(artifactMessages.length, 0, 'Opening does not send a message')
    const selectQuote = async () => {
      await dialog.locator('.artifact-dialog-preview .prose p').evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        window.getSelection().removeAllRanges()
        window.getSelection().addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await dialog.getByRole('button', { name: 'Quote selection' }).click()
    }
    await selectQuote()
    await dialog.getByRole('button', { name: 'Remove quote' }).click()
    assert.equal(artifactMessages.length, 0, 'Canceling quote does not send')
    await selectQuote()
    await dialog.getByPlaceholder('Message Content Writer…').fill('Make this sentence clearer.')
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await dialog.getByRole('button', { name: 'Remove quote' }).waitFor({ state: 'hidden' })
    assert.deepEqual(artifactMessages, [{ text: 'Make this sentence clearer.', hash: 'snapshot-report', quote: 'The original published report stays unchanged when workspace files change.' }])
    const panes = await dialog.locator('.artifact-dialog-preview, .artifact-dialog-thread').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }))
    assert(panes[0].width > 400 && panes[1].width > 300 && panes[0].x < panes[1].x, 'Preview and conversation have usable side-by-side space')
    await page.screenshot({ path: resolve(artifacts, `artifact-preview-${theme}-${palette}.png`), fullPage: true })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(await page.locator(':focus').textContent().then(text => text.includes('Writing report')), true, 'Close restores artifact card focus')
    await page.getByRole('button', { name: 'Project settings', exact: true }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = page.locator('.memory-edit textarea')
    await editor.fill('My revised headings convention.')
    latest = { ...memory, version: 2, data: { text: 'Another person changed the convention.', tags: ['updated'] } }
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText(/Someone changed this while you were editing/).waitFor()
    assert.equal(await editor.inputValue(), 'My revised headings convention.')
    assert.deepEqual(edits[0], { text: 'My revised headings convention.', expected_version: 1, tags: ['writing'] })
    await page.screenshot({ path: resolve(artifacts, `memory-conflict-${theme}-${palette}.png`), fullPage: true })
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
    assert.equal(await page.locator('html').getAttribute('data-palette'), palette)
    if (large) {
      assert.equal(await page.locator('html').getAttribute('data-density'), 'comfortable')
      assert.equal(await page.locator('html').getAttribute('data-text-size'), 'large')
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No page overflow')
    assert.deepEqual(errors, [], 'No unhandled browser errors')
    assert.deepEqual(fixtures.unexpected, [], 'No unhandled fixture routes')
    console.log(`PASS ${theme}/${palette}${large ? '/large/comfortable' : ''}: artifact document, source message, concurrent memory edit`)
    await context.close()
  }
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(artifacts, 'artifact-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  vite.kill()
}

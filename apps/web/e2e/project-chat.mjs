/* global process, console, fetch, localStorage, location, window, document, getComputedStyle */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { installFixtures, workspace } from './fixtures.mjs'

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
  await waitFor(async () => {
    if (vite.exitCode !== null) throw new Error(`Vite stopped: ${serverOutput}`)
    try { return (await fetch(origin)).ok } catch { return false }
  }, 'Vite startup')
  browser = await chromium.launch({ executablePath, headless: true })
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    const fixtures = await installFixtures(context)
    const errors = []
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
    await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Reference site</h1>' }))
    await context.addInitScript(({ workspace, theme, origin }) => {
      if (location.origin !== origin) return
      if (!localStorage.getItem('tnega.workspace')) localStorage.setItem('tnega.workspace', workspace)
      localStorage.setItem('tnega.theme', theme)
      localStorage.setItem('tnega.mode', 'projects')
    }, { workspace, theme, origin })
    const page = await context.newPage()
    activePage = page
    page.setDefaultTimeout(10000)
    await page.goto(`${origin}/#p/project`)
    const main = page.locator('.project-main')
    await main.getByRole('heading', { name: 'Writing site', exact: true }).waitFor()
    await check(`${theme}: compact independent bubbles`, async () => {
      assert.equal(await main.locator('.room-message').count(), 5)
      assert.equal(await main.locator('.room-run-agent').first().locator('.room-message').count(), 3)
      const style = await main.locator('.room-message .prose').first().evaluate(element => ({
        font: getComputedStyle(element).fontSize, body: getComputedStyle(document.body).fontSize,
        border: getComputedStyle(element.parentElement).borderTopWidth,
      }))
      assert.equal(style.font, '13.5px')
      assert.equal(style.body, '13px')
      assert.equal(style.border, '0px')
      const bubble = await main.locator('.room-run-agent .room-message').first().boundingBox()
      assert(bubble && bubble.height <= 44, `A one-line bubble should fit its text: ${bubble?.height}px`)
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
      await noOverflow(page)
      await page.screenshot({ path: resolve(artifacts, `project-${theme}.png`), fullPage: true })
    })
    await check(`${theme}: grouped receipt opens the exact conversation`, async () => {
      await main.getByRole('button', { name: 'Open conversation with Coordinator', exact: true }).click()
      const direct = page.getByRole('log', { name: 'Agent conversation' })
      await direct.waitFor()
      assert.equal(await direct.getByText('Draft ready. See docs/brief.md.', { exact: true }).count(), 1)
      assert.equal(await direct.getByText('PRIVATE PAIR: Please review the headings.', { exact: true }).count(), 0)
      await page.getByRole('button', { name: 'Close chat', exact: true }).click()
      await main.getByRole('button', { name: 'Messaged 2 Agents', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Content Writer', exact: true }).click()
      const exchange = page.getByRole('log', { name: 'Agent conversation' })
      await exchange.waitFor()
      assert.equal(await exchange.locator('.room-message').count(), 3)
      assert.equal(await exchange.getByText('Coordinator', { exact: true }).count(), 1)
      assert.equal(await exchange.getByText('Content Writer', { exact: true }).count(), 1)
      assert.equal(await exchange.getByText('PRIVATE PAIR: Please review the headings.', { exact: true }).count(), 0)
      assert.equal(await main.getByText('Please remove hardware topics.', { exact: true }).count(), 0)
      await page.screenshot({ path: resolve(artifacts, `exchange-${theme}.png`), fullPage: true })
    })
    await check(`${theme}: late SSE arrival is deduplicated and reconnects from its cursor`, async () => {
      fixtures.releaseLate()
      const exchange = page.getByRole('log', { name: 'Agent conversation' })
      await exchange.getByText('The shorter draft is ready.', { exact: true }).waitFor()
      assert.equal(await exchange.getByText('The shorter draft is ready.', { exact: true }).count(), 1)
      await waitFor(() => fixtures.streamCursors.includes(11), 'reconnect after cursor 11')
      assert.equal(await exchange.getByText('The shorter draft is ready.', { exact: true }).count(), 1)
    })
    await check(`${theme}: reload retains exchange history; participants open direct Thread chat`, async () => {
      await page.reload()
      await main.getByRole('button', { name: 'Messaged 2 Agents', exact: true }).first().click()
      await page.getByRole('menuitem', { name: 'Content Writer', exact: true }).click()
      await page.getByRole('log', { name: 'Agent conversation' }).waitFor()
      assert.equal(await page.getByRole('log', { name: 'Agent conversation' }).getByText('The shorter draft is ready.', { exact: true }).count(), 1)
      await page.getByRole('button', { name: 'Open Content Writer', exact: true }).click()
      await page.getByText('Done. The headings are shorter.', { exact: true }).waitFor()
      const threadChat = page.getByRole('log', { name: 'Thread conversation' })
      assert.equal(await threadChat.count(), 1)
      assert.equal(await threadChat.getByText('Please remove hardware topics.', { exact: true }).count(), 0)
      assert.equal(new URL(page.url()).hash, '#p/project/writer')
      await page.reload()
      await page.getByText('Done. The headings are shorter.', { exact: true }).waitFor()
      await main.getByRole('button', { name: 'Messaged 2 Agents', exact: true }).first().click()
      await page.getByRole('menuitem', { name: 'Content Writer', exact: true }).click()
      await page.getByRole('button', { name: 'Close chat', exact: true }).click()
      assert.equal(await page.locator('.exchange-panel').count(), 0)
    })
    await check(`${theme}: message file and web links open their intended surfaces`, async () => {
      await main.getByRole('link', { name: 'docs/brief.md', exact: true }).click()
      await page.locator('.cm-content').getByText('# Short writing brief', { exact: true }).waitFor()
      const popupPromise = context.waitForEvent('page')
      await main.getByRole('link', { name: 'reference site', exact: true }).click()
      const popup = await popupPromise
      await popup.waitForLoadState()
      assert.equal(new URL(popup.url()).hostname, 'example.com')
      await popup.close()
      await main.getByRole('link', { name: 'http://localhost:4173', exact: true }).click()
      await waitFor(() => fixtures.navigation.includes('http://localhost:4173/'), 'local URL browser navigation')
      await page.getByRole('tab', { name: 'Browser', exact: true }).waitFor()
    })
    await check(`${theme}: narrow layout fits viewport and exchange remains usable`, async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.keyboard.press('Control+j')
      await page.keyboard.press('Control+b')
      await main.getByRole('button', { name: 'Messaged 2 Agents', exact: true }).first().click()
      await page.getByRole('menuitem', { name: 'Content Writer', exact: true }).click()
      await page.getByRole('log', { name: 'Agent conversation' }).waitFor()
      await noOverflow(page)
      await page.screenshot({ path: resolve(artifacts, `exchange-narrow-${theme}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Close chat', exact: true }).click()
    })
    await check(`${theme}: long exchange scrolls and crowded tabs remain reachable`, async () => {
      await page.setViewportSize({ width: 1440, height: 700 })
      fixtures.expandHistory()
      await page.reload()
      await main.getByRole('button', { name: 'Messaged 2 Agents', exact: true }).first().click()
      await page.getByRole('menuitem', { name: 'Content Writer', exact: true }).click()
      const pair = page.locator('.exchange-pair')
      const toolbar = page.locator('.exchange-toolbar')
      const pairBox = await pair.boundingBox()
      const toolbarBox = await toolbar.boundingBox()
      assert(Math.abs(pairBox.x + pairBox.width / 2 - toolbarBox.x - toolbarBox.width / 2) < 2, 'Participant pair is centered')
      const body = page.locator('.exchange-body')
      await waitFor(() => body.evaluate(element => element.scrollTop > 0), 'initial scroll to latest message')
      assert(await body.evaluate(element => element.scrollHeight > element.clientHeight + 100), 'History overflows its scroll container')
      await body.hover()
      await page.mouse.wheel(0, -100000)
      await waitFor(() => body.evaluate(element => element.scrollTop === 0), 'scroll to first message')
      await body.getByText('Use the brief. Keep the scope small.', { exact: true }).click()
      await page.getByRole('button', { name: 'Open Content Writer', exact: true }).click()
      await main.getByRole('button', { name: 'Messaged 2 Agents', exact: true }).first().click()
      await page.getByRole('menuitem', { name: 'Content Writer', exact: true }).click()
      await page.setViewportSize({ width: 390, height: 700 })
      const rail = page.getByRole('tablist', { name: 'Workbench', exact: true })
      await rail.evaluate(element => { element.scrollLeft = 0 })
      assert(await rail.evaluate(element => element.scrollWidth > element.clientWidth), 'Tabs overflow horizontally')
      await rail.hover()
      await page.mouse.wheel(0, 100000)
      await waitFor(() => rail.evaluate(element => element.scrollLeft > 0), 'ordinary wheel scrolls tabs')
      await page.getByRole('tab', { name: 'Browser', exact: true }).click()
      await page.screenshot({ path: resolve(artifacts, `scroll-tabs-${theme}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Close workbench', exact: true }).click()
      const input = main.getByRole('textbox', { name: 'Message', exact: true })
      assert.equal(await main.getByRole('button', { name: 'Send', exact: true }).count(), 0)
      await input.fill('One short update')
      assert.equal(await main.getByRole('button', { name: 'Send', exact: true }).count(), 1)
      assert.equal(await main.getByRole('button', { name: 'Stop', exact: true }).count(), 0)
      await input.fill('')
      assert.equal(await main.getByRole('button', { name: 'Stop', exact: true }).count(), 1)
    })
    await check(`${theme}: ordinary Session has plain messages and opens user/Agent references`, async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      if (!await page.getByRole('tab', { name: 'Sessions', exact: true }).isVisible()) await page.keyboard.press('Control+b')
      await page.getByRole('tab', { name: 'Sessions', exact: true }).click()
      await page.getByTitle('Short general chat', { exact: true }).click()
      assert.equal(new URL(page.url()).hash, '#session-fixture')
      const user = page.locator('.user-bubble')
      const agent = page.locator('.agent-body')
      await agent.getByText('Done. See', { exact: false }).waitFor()
      const style = await user.evaluate(element => ({ user: getComputedStyle(element).fontSize,
        body: getComputedStyle(document.body).fontSize, agent: getComputedStyle(document.querySelector('.agent-body .prose')).fontSize }))
      assert.equal(style.body, '13px')
      assert.equal(style.user, '13.5px')
      assert.equal(style.agent, '13.5px')
      for (const element of [user, agent.locator('.prose')]) {
        assert.equal(await element.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Ordinary messages have no bubble background')
      }
      const bubble = await agent.locator('.prose').boundingBox()
      assert(bubble && bubble.height < 45, `Short Agent response should fit one compact line: ${JSON.stringify(bubble)}`)
      for (const [message, reference, suffix] of [[user, 'user reference', 'user'], [agent, 'agent reference', 'agent']]) {
        await message.getByRole('link', { name: 'docs/brief.md', exact: true }).click()
        await page.locator('.cm-content').getByText('# Short writing brief', { exact: true }).waitFor()
        const popupPromise = context.waitForEvent('page')
        await message.getByRole('link', { name: reference, exact: true }).click()
        const popup = await popupPromise
        await popup.waitForLoadState()
        assert.equal(popup.url(), `https://example.com/${suffix}`)
        await popup.close()
      }
      await noOverflow(page)
      await page.screenshot({ path: resolve(artifacts, `session-${theme}.png`), fullPage: true })
    })
    assert.deepEqual(errors, [], `${theme}: unhandled browser exceptions`)
    assert.deepEqual(fixtures.unexpected, [], `${theme}: unhandled API routes`)
    await context.close()
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

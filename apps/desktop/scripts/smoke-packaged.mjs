// Launch a packaged Tnega, prove it works, and quit. CI runs this on the
// macOS and Linux runners, where nobody on the team has a machine.
//
//   node apps/desktop/scripts/smoke-packaged.mjs <executable> [--screenshot out.png] [-- app args]
//
// It checks, in order: the app starts and its embedded Chromium opens a
// DevTools endpoint; the window loads the local server; the renderer sees the
// desktop bridge and keeps clear of the native window buttons on the right
// side for this platform; and a Workbench terminal (node-pty, a native module)
// runs a command. Exit code 0 means every check passed.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout as sleep } from 'node:timers/promises'
import { URL } from 'node:url'
import { TextDecoderStream } from 'node:stream/web'

const { fetch } = globalThis

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const own = separator < 0 ? argv : argv.slice(0, separator)
const appArgs = separator < 0 ? [] : argv.slice(separator + 1)
const executable = own[0]
const screenshot = own.includes('--screenshot') ? own[own.indexOf('--screenshot') + 1] : undefined
if (!executable) throw new Error('usage: smoke-packaged.mjs <executable> [--screenshot out.png] [-- app args]')

const deadline = Date.now() + 120_000
const workspace = mkdtempSync(join(tmpdir(), 'tnega-smoke-'))
const log = []
const child = spawn(executable, appArgs, {
  // A process group, so the whole app (helpers, AppImage launcher) stops together.
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
})
let exited
child.on('exit', (code, signal) => { exited = { code, signal } })
child.on('error', error => { exited = { error: error.message } })
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', chunk => { log.push(chunk) })
}

function step(message) { console.log(`smoke: ${message}`) }
async function until(what, probe) {
  let last
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the app exited (${JSON.stringify(exited)}) while waiting for ${what}`)
    try {
      const value = await probe(observed => { last = observed })
      if (value) return value
    } catch (error) { last = error instanceof Error ? error.message : error }
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}; last seen: ${JSON.stringify(last)}`)
}

/** Evaluate an expression in the page over the DevTools protocol. */
async function evaluate(webSocketUrl, expression) {
  const socket = new globalThis.WebSocket(webSocketUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  try {
    const reply = new Promise((resolve, reject) => {
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
        else resolve(message.result.result.value)
      }
    })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    return await reply
  } finally { socket.close() }
}

async function run() {
  // The app asks Chromium for a DevTools port of its own; Chromium logs where.
  const devtools = await until('the DevTools endpoint', () => {
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(log.join(''))
    return match ? new URL(match[1]) : undefined
  })
  step(`app started, DevTools on port ${devtools.port}`)

  const page = await until('the window to load the local server', async () => {
    const targets = await (await fetch(`http://127.0.0.1:${devtools.port}/json/list`)).json()
    return targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url))
  })
  const server = new URL(page.url).origin
  const index = await fetch(server)
  if (!index.ok || !(await index.text()).includes('<div id="root"')) throw new Error(`${server} did not serve the web UI (${index.status})`)
  step(`window loaded ${server}`)

  const chrome = await until('the renderer to mark the window controls', async observe => {
    const value = await evaluate(page.webSocketDebuggerUrl, `({
      size: [innerWidth, innerHeight],
      headers: [...document.querySelectorAll('.sidebar-top, .conv-header')].map(header => header.className + ' ' + JSON.stringify(header.getBoundingClientRect())),
      platform: window.tnegaDesktop?.platform,
      desktop: document.documentElement.classList.contains('desktop-chrome'),
      left: document.documentElement.classList.contains('window-controls-left'),
      clearedLeft: document.querySelectorAll('.window-controls-header-start').length,
      clearedRight: document.querySelectorAll('.window-controls-header').length,
    })`)
    observe(value)
    return value?.desktop && value.clearedLeft + value.clearedRight > 0 ? value : undefined
  })
  const mac = process.platform === 'darwin'
  if (chrome.platform !== process.platform || chrome.left !== mac || (mac ? chrome.clearedLeft < 1 || chrome.clearedRight > 0 : chrome.clearedLeft > 0)) {
    throw new Error(`window controls are on the wrong side: ${JSON.stringify(chrome)}`)
  }
  step(`renderer keeps the ${mac ? 'top-left' : 'top-right'} header clear of the window buttons`)

  const api = (path, init = {}) => fetch(`${server}/api${path}`, {
    ...init, headers: { 'x-tnega-client': '1', 'content-type': 'application/json', ...init.headers },
  })
  const created = await api(`/terminals?workspace=${encodeURIComponent(workspace)}`, { method: 'POST', body: JSON.stringify({ cols: 80, rows: 24 }) })
  if (!created.ok) throw new Error(`terminal did not start: ${created.status} ${await created.text()}`)
  const terminal = await created.json()
  const stream = await api(`/terminals/${terminal.id}/stream`)
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
  let output = ''
  const sawMarker = (async () => {
    while (!output.includes('tnega-smoke-42')) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`terminal stream ended: ${output}`)
      output += value
    }
  })()
  await api(`/terminals/${terminal.id}/input`, { method: 'POST', body: JSON.stringify({ data: 'echo tnega-smoke-$((6*7))\r' }) })
  await Promise.race([sawMarker, sleep(30_000).then(() => { throw new Error(`terminal printed no marker: ${output}`) })])
  await reader.cancel()
  await api(`/terminals/${terminal.id}`, { method: 'DELETE' })
  step(`terminal (node-pty) ran ${terminal.shell}`)

}

/** The whole screen, native window buttons included; a missing capture tool is not a failure. */
function capture() {
  if (!screenshot || exited) return
  mkdirSync(dirname(screenshot), { recursive: true })
  const result = process.platform === 'darwin'
    ? spawnSync('screencapture', ['-x', screenshot])
    : spawnSync('import', ['-window', 'root', screenshot])
  step(result.status === 0 ? `screenshot saved to ${screenshot}` : `screenshot skipped (${result.error?.message ?? result.stderr})`)
}

let failure
try {
  await run()
  // Give fonts and the greeting a moment before the picture.
  await sleep(3_000)
} catch (error) { failure = error }
capture()
if (!exited) {
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM') } catch { /* already gone */ }
  for (let i = 0; i < 20 && !exited; i++) await sleep(500)
  if (!exited) try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') } catch { /* already gone */ }
}
rmSync(workspace, { recursive: true, force: true })
if (failure) {
  console.error(`smoke: FAILED: ${failure.message}`)
  console.error('--- app output ---')
  console.error(log.join('').slice(-8_000))
  process.exit(1)
}
step('all checks passed')

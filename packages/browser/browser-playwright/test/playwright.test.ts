import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { tools, type ToolsService } from '@tnega/tools'
import { toolBrowser } from '@tnega/tool-browser'

import { browserPlaywright, evaluationSource, launchPageSource, PlaywrightBrowserHost } from '../src/index.js'

const APP = `<!doctype html>
<title>Todo</title>
<h1>Todos</h1>
<label>New todo <input id="todo"></label>
<button id="add">Add</button>
<ul id="list"></ul>
<script>
  document.getElementById('add').onclick = () => {
    const input = document.getElementById('todo')
    const item = document.createElement('li')
    item.textContent = input.value
    document.getElementById('list').append(item)
    input.value = ''
    console.error('added ' + item.textContent)
    fetch('/missing.json')
  }
</script>`

let server: Server
let base = ''
let available = true

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      res.end(APP)
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Skip on machines without Edge, Chrome or Playwright's Chromium.
  const probe = new PlaywrightBrowserHost(launchPageSource({ headless: true }))
  try {
    await probe.page()
  } catch {
    available = false
  } finally {
    await probe.close()
  }
}, 60_000)

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

describe('evaluationSource', () => {
  it('calls functions and wraps expressions', () => {
    expect(evaluationSource('() => 1')).toBe('(() => 1)()')
    expect(evaluationSource('async function f() { return 1 }')).toBe('(async function f() { return 1 })()')
    expect(evaluationSource('document.title')).toBe('(async () => (document.title))()')
  })
})

describe('browser-playwright with tool-browser', () => {
  it('drives a local page through snapshot refs, records console and network, and screenshots', async ({ skip }) => {
    if (!available) skip()
    const root = new Context()
    await root.plugin(tools)
    const provider = await root.plugin(browserPlaywright, { launch: { headless: true } })
    await root.plugin(toolBrowser)
    const registry = root.get('tools') as ToolsService
    const call = async (name: string, input: unknown) => {
      const result = await registry.execute(name, input, {})
      if (!result.ok) throw new Error(`${name}: ${result.error?.message}`)
      return result
    }

    try {
      const opened = String((await call('browser_navigate', { url: base })).output)
      expect(opened).toContain('HTTP 200')
      expect(opened).toContain('Title: Todo')
      const textbox = /textbox "New todo" \[ref=(e\d+)\]/u.exec(opened)?.[1]
      const button = /button "Add" \[ref=(e\d+)\]/u.exec(opened)?.[1]
      expect(textbox && button).toBeTruthy()

      await call('browser_type', { ref: textbox, text: 'buy milk' })
      const clicked = String((await call('browser_click', { ref: button, element: 'Add button' })).output)
      expect(clicked).toContain('listitem')
      expect(clicked).toContain('buy milk')
      expect(clicked).toContain('[error] added buy milk')

      const stale = await registry.execute('browser_click', { ref: 'e999' }, {})
      expect(stale.ok).toBe(false)
      expect(stale.error?.message).toContain('take a new snapshot')

      await expect.poll(async () => String((await call('browser_network_requests', { onlyFailed: true })).output)).toContain('/missing.json → 404')
      expect(String((await call('browser_evaluate', { function: '() => document.querySelectorAll("li").length' })).output)).toBe('1')

      const shot = await call('browser_take_screenshot', {})
      expect(shot.attachments?.[0]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' })
      expect(shot.attachments![0]!.data.length).toBeGreaterThan(1000)

      const mobile = String((await call('browser_resize', { width: 375, height: 700 })).output)
      expect(mobile).toContain('viewport 375x700')
    } finally {
      await provider.dispose()
    }
  }, 90_000)
})

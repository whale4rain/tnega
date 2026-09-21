// Run with: pnpm --filter @tnega/desktop exec electron scripts/verify-workbench.cjs
// Uses a disposable session and fixture API; never reads user workspaces or credentials.
const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { readFile, mkdir, writeFile } = require('node:fs/promises')
const { join, extname } = require('node:path')
const assert = require('node:assert/strict')
const webRoot = join(__dirname, '../../../dist/web')
const output = join(__dirname, '../release')
const workspace = 'D:/projects/tnega'
const summary = {
  id: 'preview',
  workspace,
  title: 'Refactor the session lifecycle',
  agentType: 'coding',
  mode: 'auto',
  createdAt: 1,
  updatedAt: 1,
  eventCount: 2,
}
const events = [
  {
    id: 'u1',
    seq: 1,
    ts: 1,
    type: 'user/message',
    payload: {
      content:
        'Review the session lifecycle and suggest a cleaner module structure.\n\nKeep the public API compatible.',
    },
  },
  {
    id: 'a1',
    seq: 2,
    ts: 2,
    type: 'assistant/message',
    payload: {
      content:
        '## A smaller surface for session management\n\nThe current implementation mixes persistence, event projection, and live state. We can make these responsibilities easier to reason about with three focused modules.\n\n- **Session store** — owns durable events and recovery.\n- **Event projection** — turns events into the conversation you see.\n- **Run controller** — coordinates cancellation and cleanup.\n\n### Keep the boundary explicit\n\nThe interface only needs to expose the operations its callers use:\n\n```typescript\ninterface SessionStore {\n  append(event: SessionEvent): Promise<void>\n  replay(): AsyncIterable<SessionEvent>\n  close(): Promise<void>\n}\n```\n\nThis keeps the agent loop independent of the storage format. Existing sessions remain readable, and shutdown can await the same `close()` boundary.\n\nI would start with the store contract, then move projection into a pure function with recovery tests.',
    },
  },
]
events.splice(
  1,
  0,
  {
    id: 'call1',
    type: 'tool/call',
    payload: {
      id: 'read1',
      name: 'read_file',
      arguments: { path: 'src/session/store.ts' },
    },
  },
  {
    id: 'result1',
    type: 'tool/result',
    payload: {
      id: 'result1',
      toolCallId: 'read1',
      name: 'read_file',
      ok: true,
      output: 'export interface SessionStore { close(): Promise<void> }',
      durationMs: 12,
    },
  },
  {
    id: 'call2',
    type: 'tool/call',
    payload: {
      id: 'shell1',
      name: 'shell',
      arguments: { command: 'pnpm test -- session' },
    },
  },
  {
    id: 'result2',
    type: 'tool/result',
    payload: {
      id: 'result2',
      toolCallId: 'shell1',
      name: 'shell',
      ok: true,
      output: 'Tests: 12 passed',
      durationMs: 890,
    },
  },
)
// Some providers stream whitespace-only assistant frames between tool calls.
events.splice(3, 0, { id: 'blank-assistant', type: 'assistant/message', payload: { content: '  \n ' } })
events.push({
  id: 'plan',
  type: 'plan',
  payload: {
    summary: 'Refine session boundaries',
    status: 'running',
    items: [
      { id: 'p1', title: 'Inspect the session store', status: 'done' },
      {
        id: 'p2',
        title: 'Extract projection and add recovery tests',
        status: 'pending',
      },
    ],
  },
})
events.push({ id: 'u2', type: 'user/message', payload: { content: 'Add recovery tests and keep the public API stable.' } })
events.forEach((event, index) => {
  event.seq = index + 1
  event.ts = index + 1
})
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    const value =
      path === '/api/config'
        ? {
            apiKeySet: true,
            effective: { model: 'local-preview', baseUrl: '' },
            config: { apiKeySet: true },
            env: { apiKeySet: false },
          }
        : path === '/api/workspaces'
          ? { workspaces: [workspace] }
          : path === '/api/sessions'
            ? {
                sessions: [
                  summary,
                  { ...summary, id: 'second', title: 'Explore the codebase' },
                ],
              }
            : path.includes('commands')
              ? { commands: [] }
              : {
                  summary,
                  events,
                  running: false,
                  context: { ratio: 0.12, tokens: 12000, limit: 100000 },
                }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value))
    return
  }
  try {
    const file = join(webRoot, path === '/' ? 'index.html' : path)
    res.setHeader(
      'content-type',
      { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[
        extname(file)
      ] || 'application/octet-stream',
    )
    res.end(await readFile(file))
  } catch {
    res.writeHead(404)
    res.end()
  }
})
let win
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${expression}`)
}
async function run() {
  await app.whenReady()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: {
      partition: 'workbench-visual-test',
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  await win.loadURL(`http://127.0.0.1:${server.address().port}`)
  // Capture settled layouts rather than paused compositor animation frames in a hidden window.
  await win.webContents.executeJavaScript(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '* , *::before, *::after, *::details-content { transition: none !important; animation: none !important; }' }))`)
  await waitFor(`!!document.querySelector('.session-link')`)
  await win.webContents.executeJavaScript(
    `document.querySelector('.session-link').click()`,
  )
  await waitFor(`!!document.querySelector('.message.assistant')`)
  await mkdir(output, { recursive: true })
  await win.webContents.executeJavaScript(
    `document.querySelector('.conversation-scroll').scrollTop = 0`,
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  await writeFile(
    join(output, 'workbench-preview.png'),
    (await win.webContents.capturePage()).toPNG(),
  )
  const metrics = await win.webContents.executeJavaScript(`({
    font: getComputedStyle(document.querySelector('.message')).fontFamily,
    size: getComputedStyle(document.querySelector('.message')).fontSize,
    sidebar: document.querySelector('.workspace-sidebar').getBoundingClientRect().width,
    input: document.querySelector('.composer').getBoundingClientRect().bottom,
    viewport: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth,
    flex: getComputedStyle(document.querySelector('.workbench-body')).display,
    scrollBottom: document.querySelector('.conversation-scroll').getBoundingClientRect().bottom,
    planBottom: document.querySelector('.plan-panel').getBoundingClientRect().bottom,
    inputTop: document.querySelector('.composer').getBoundingClientRect().top
  })`)
  assert.equal(metrics.flex, 'flex')
  assert.equal(metrics.size, '13px')
  assert.equal(metrics.overflow, false)
  assert.ok(metrics.input < metrics.viewport)
  assert.ok(
    Math.abs(metrics.scrollBottom - metrics.viewport) <= 1,
    'scroll track must reach the window bottom',
  )
  assert.ok(
    metrics.planBottom < metrics.inputTop,
    'plan belongs above the input',
  )
  const chrome = await win.webContents.executeJavaScript(`(() => {
    const search = document.querySelector('[aria-label="Search sessions"]'); search.focus();
    return { height: document.querySelector('.window-bar').getBoundingClientRect().height,
      outline: getComputedStyle(search).outlineStyle,
      fieldOutline: getComputedStyle(search.closest('.rt-TextFieldRoot')).outlineStyle,
      groups: document.querySelectorAll('.messages > .tool-group').length,
      assistants: document.querySelectorAll('.message.assistant').length };
  })()`)
  assert.equal(chrome.height, 32)
  assert.equal(chrome.outline, 'none')
  assert.equal(chrome.fieldOutline, 'none')
  assert.equal(chrome.groups, 1)
  assert.equal(chrome.assistants, 1)
  await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Toggle Terminal"]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))`)
  await waitFor(`!!document.querySelector('.rt-TooltipText')`)
  const toolTooltip = await win.webContents.executeJavaScript(`(() => {
    const text = document.querySelector('.rt-TooltipText');
    return { foreground: getComputedStyle(text).color, background: getComputedStyle(text.closest('.rt-TooltipContent')).backgroundColor };
  })()`)
  // Radix uses display-p3 on capable renderers; these tooltip colors are neutral grays.
  const luminance = (color) => {
    const values = color.match(/[\d.]+/g).map(Number)
    const channels = color.startsWith('color(') ? values.slice(1, 4) : values.slice(0, 3).map((value) => value / 255)
    return channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  }
  const fg = luminance(toolTooltip.foreground), bg = luminance(toolTooltip.background)
  assert.ok((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) >= 4.5, `tool tooltip must have readable contrast: ${JSON.stringify(toolTooltip)}`)
  await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Toggle Terminal"]').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`)
  const surfaces = await win.webContents.executeJavaScript(`(() => {
    const main = document.querySelector('.main');
    const message = document.querySelector('.message.user');
    const bubble = message.querySelector('.message-body');
    const rect = bubble.getBoundingClientRect();
    const column = document.querySelector('.messages').getBoundingClientRect();
    return {
      ratio: rect.width / column.width,
      rightGap: Math.abs(rect.right - column.right),
      bubbleColor: getComputedStyle(bubble).backgroundColor,
      border: getComputedStyle(bubble).borderTopWidth,
      radius: parseFloat(getComputedStyle(main).borderTopLeftRadius),
      shell: getComputedStyle(document.querySelector('.workbench-body')).backgroundColor,
      top: getComputedStyle(document.querySelector('.window-bar')).backgroundColor,
      canvas: getComputedStyle(main).backgroundColor,
      row: document.querySelector('.session-item').getBoundingClientRect().height,
    };
  })()`)
  assert.ok(surfaces.ratio <= 0.71, 'user bubble must not fill the transcript width')
  assert.ok(surfaces.rightGap < 2, 'user bubble must align right')
  assert.equal(surfaces.bubbleColor, 'rgb(38, 61, 112)')
  assert.equal(surfaces.border, '0px')
  assert.ok(surfaces.radius >= 12)
  assert.equal(surfaces.shell, surfaces.top)
  assert.notEqual(surfaces.shell, surfaces.canvas)
  assert.ok(surfaces.row <= 32, 'sidebar rows must stay compact')
  await win.webContents.executeJavaScript(`document.querySelector('.turn-marker').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))`)
  await waitFor(`!!document.querySelector('[role="tooltip"]')`)
  const tooltipContrast = await win.webContents.executeJavaScript(`(() => {
    const style = getComputedStyle(document.querySelector('.turn-tooltip'));
    return { text: getComputedStyle(document.querySelector('.turn-preview')).color, background: style.backgroundColor };
  })()`)
  assert.notEqual(tooltipContrast.text, tooltipContrast.background)
  assert.equal(tooltipContrast.text, 'rgb(217, 217, 212)')
  await writeFile(join(output, 'workbench-navigation-preview.png'), (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript(`document.querySelector('.turn-marker:last-child').click()`)
  await waitFor(`document.querySelector('.turn-marker:last-child').getAttribute('aria-current') === 'step'`)
  await win.webContents.executeJavaScript(`document.querySelector('.turn-marker').dispatchEvent(new FocusEvent('focusout', { bubbles: true })); document.querySelector('.conversation-scroll').scrollTop = 0`)
  await win.webContents.executeJavaScript(
    `document.querySelector('.tool-group > summary').click()`,
  )
  await waitFor(`document.querySelector('.tool-group').open`)
  await win.webContents.executeJavaScript(
    `document.querySelector('.tool-group-items summary').click()`,
  )
  await waitFor(`document.querySelector('.tool-group-items details').open`)
  await waitFor(`document.querySelector('.tool-group-items .tool-detail').getBoundingClientRect().height > 40`)
  await new Promise((resolve) => setTimeout(resolve, 220))
  await writeFile(
    join(output, 'workbench-activity-preview.png'),
    (await win.webContents.capturePage()).toPNG(),
  )
  await win.webContents.executeJavaScript(
    `const scroller = document.querySelector('.conversation-scroll'); scroller.scrollTop = scroller.scrollHeight`,
  )
  await new Promise((resolve) => setTimeout(resolve, 220))
  const latestVisible = await win.webContents.executeJavaScript(
    `document.querySelector('.messages').getBoundingClientRect().bottom <= document.querySelector('.composer-surface').getBoundingClientRect().top + 1`,
  )
  assert.ok(
    latestVisible,
    'last message must not be hidden behind the composer',
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Collapse sidebar"]').click(); document.querySelector('[aria-label="Toggle Files"]').click()`,
  )
  await waitFor(
    `document.querySelector('.workspace-sidebar').getAttribute('aria-hidden') === 'true' && !!document.querySelector('.tools-panel')`,
  )
  await writeFile(
    join(output, 'workbench-tools-preview.png'),
    (await win.webContents.capturePage()).toPNG(),
  )
  win.setSize(600, 800)
  await waitFor('innerWidth <= 600')
  assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.conversation-nav').getBoundingClientRect().right <= document.querySelector('.messages').getBoundingClientRect().left`), 'turn ruler must not overlap narrow transcript')
  assert.equal(
    await win.webContents.executeJavaScript(
      'document.documentElement.scrollWidth > innerWidth',
    ),
    false,
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Close tools panel"]').click()`,
  )
  await waitFor(`getComputedStyle(document.querySelector('.workspace-sidebar')).visibility === 'hidden'`)
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.ok(
    await win.webContents.executeJavaScript(
      `document.querySelector('.composer').getBoundingClientRect().bottom < innerHeight`,
    ),
    'input must remain visible on narrow windows',
  )
  await writeFile(
    join(output, 'workbench-mobile-preview.png'),
    (await win.webContents.capturePage()).toPNG(),
  )
  console.log(
    JSON.stringify({ status: 'passed', metrics, screenshots: output }),
  )
}
run().then(
  () => {
    win?.destroy()
    server.close()
    app.exit(0)
  },
  (error) => {
    console.error(error)
    win?.destroy()
    server.close()
    app.exit(1)
  },
)

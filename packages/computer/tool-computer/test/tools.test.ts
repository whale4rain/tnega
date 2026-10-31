import { describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import {
  ComputerError,
  ComputerService,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerScreenshot,
  type ComputerTree,
  type ComputerWindow,
} from '@tnega/computer'
import { tools, type ToolResult } from '@tnega/tools'

import { parseKeys, toolComputer, type ToolComputerConfig } from '../src/index.js'

const WINDOWS: ComputerWindow[] = [
  { id: 1, pid: 10, app: 'chrome.exe', title: 'Example', bounds: { x: 0, y: 0, width: 1280, height: 800 }, onScreen: true },
  { id: 2, pid: 20, app: 'notepad.exe', title: 'notes', bounds: { x: 0, y: 0, width: 600, height: 400 }, onScreen: true },
]

class FakeComputer extends ComputerService {
  performed: ComputerAction[] = []
  open = [...WINDOWS]
  shotFails = false

  async windows(): Promise<ComputerWindow[]> {
    return this.open
  }

  async screenshot(windowId: number): Promise<ComputerScreenshot> {
    const window = this.open.find(item => item.id === windowId)
    if (this.shotFails) throw new ComputerError('COMPUTER_FAILED', 'capture timed out')
    if (!window) throw new ComputerError('COMPUTER_NO_WINDOW', `window ${windowId} is not open`)
    return { windowId, app: window.app, title: window.title, width: 1280, height: 800, mediaType: 'image/png', data: 'cG5n' }
  }

  async zoom(windowId: number): Promise<ComputerScreenshot> {
    return this.screenshot(windowId)
  }

  override async apps(): Promise<ComputerApp[]> {
    return [
      { name: 'Notepad', id: 'Microsoft.WindowsNotepad', running: true, pid: 20, windowIds: [2] },
      { name: 'Google Chrome', id: 'Chrome', running: true, pid: 10, windowIds: [1] },
      { name: 'Calculator', id: 'Microsoft.WindowsCalculator', running: false, windowIds: [] },
    ]
  }

  override async tree(windowId: number): Promise<ComputerTree> {
    return { windowId, app: 'chrome.exe', title: 'Example', snapshotId: 's00000002', markdown: '- [5] button "Save"\n', total: 40, returned: 3, truncated: true }
  }

  protected async runAction(action: ComputerAction): Promise<ComputerActionResult> {
    this.performed.push(action)
    if (action.op === 'launch') return { note: `Launched ${action.app}${action.id ? ` (${action.id})` : ''}` }
    if (action.op === 'clipboard-read') return { note: 'The clipboard holds 6 characters of text.', text: 'copied' }
    if (action.op === 'clipboard-write') return { note: `Put ${action.text.length} characters on the clipboard` }
    if (action.op === 'steps') return { note: `Ran ${action.steps.length} steps`, windowId: action.windowId, steps: action.steps.map(step => ({ ok: true, note: step.op })) }
    // Ctrl+W closes the window.
    if (action.op === 'key' && action.keys.join('+') === 'ctrl+w') this.open = this.open.filter(window => window.id !== action.windowId)
    return { note: `${action.op} done`, windowId: action.windowId }
  }
}

async function setup(config: ToolComputerConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(tools)
  const computer = new FakeComputer(ctx)
  await ctx.plugin(toolComputer, { settleMs: 0, ...config })
  const run = (name: string, input: unknown): Promise<ToolResult> => ctx.get('tools').execute(name, input)
  return { ctx, computer, run }
}

describe('tool-computer', () => {
  it('answers an action with a fresh screenshot of its window', async () => {
    const { computer, run } = await setup()
    const result = await run('computer_click', { window_id: 1, x: 40, y: 60, double: true })
    expect(result.ok).toBe(true)
    expect(computer.performed).toEqual([{ op: 'click', windowId: 1, x: 40, y: 60, count: 2 }])
    expect(String(result.output)).toMatch(/click done\nScreenshot of window 1 · chrome.exe · "Example", 1280x800 px/)
    expect(result.attachments).toEqual([{ type: 'image', mediaType: 'image/png', data: 'cG5n', name: 'window-1.png' }])
  })

  it('types, then presses Enter for submit, and says when the window closed', async () => {
    const { computer, run } = await setup()
    await run('computer_type', { window_id: 2, text: 'hello', submit: true })
    expect(computer.performed).toEqual([
      { op: 'type', windowId: 2, text: 'hello' },
      { op: 'key', windowId: 2, keys: ['enter'] },
    ])
    const closed = await run('computer_key', { window_id: 2, keys: 'ctrl+w' })
    expect(closed.ok).toBe(true)
    expect(String(closed.output)).toMatch(/Window 2 has closed/)
    expect(closed.attachments).toBeUndefined()
  })

  it('reports a done action as done when the screenshot after it fails', async () => {
    const { computer, run } = await setup()
    computer.shotFails = true
    const result = await run('computer_click', { window_id: 1, x: 1, y: 1 })
    expect(result.ok).toBe(true)
    expect(String(result.output)).toMatch(/click done\nThe action was done, but the screenshot after it failed \(capture timed out\)/)
    expect(computer.performed).toHaveLength(1)
  })

  it('stops taking screenshots once the Session spent its budget, counting earlier ones', async () => {
    // One screenshot is already in the Session from before a restart.
    const earlier = [
      { type: 'tool/result', payload: { name: 'computer_screenshot', ok: true, attachments: [{ type: 'image' }] } },
      { type: 'tool/result', payload: { name: 'browser_screenshot', ok: true, attachments: [{ type: 'image' }] } },
    ]
    const { computer, run } = await setup({ maxScreenshots: 2, session: () => ({ read: async () => earlier }) })
    const first = await run('computer_click', { window_id: 1, x: 1, y: 1 })
    expect(first.attachments).toHaveLength(1)
    // The action still happens; only the picture is left out.
    const second = await run('computer_click', { window_id: 1, x: 2, y: 2 })
    expect(computer.performed).toHaveLength(2)
    expect(second.ok).toBe(true)
    expect(second.attachments).toBeUndefined()
    expect(String(second.output)).toMatch(/click done\nNo screenshot: screenshot budget exhausted \(2 of 2 this session\)\. Read the window with computer_read_tree instead\./)
    for (const [name, input] of [['computer_screenshot', { window_id: 1 }], ['computer_zoom', { window_id: 1, x1: 0, y1: 0, x2: 9, y2: 9 }], ['computer_wait', { window_id: 1, seconds: 0 }]] as const) {
      const refused = await run(name, input)
      expect(refused.ok).toBe(false)
      expect(refused.error?.message).toMatch(/screenshot budget exhausted/)
    }
    expect((await run('computer_read_tree', { window_id: 1 })).ok).toBe(true)
  })

  it('describes windows in text for a model that cannot see images', async () => {
    let vision = false
    const { computer, run } = await setup({ maxScreenshots: 1, vision: () => vision })
    let shots = 0
    const capture = computer.screenshot.bind(computer)
    computer.screenshot = async (windowId: number) => { shots += 1; return capture(windowId) }
    const clicked = await run('computer_click', { window_id: 1, x: 1, y: 1 })
    expect(clicked.attachments).toBeUndefined()
    expect(String(clicked.output)).toBe('click done\nwindow 1 · chrome.exe · "Example" · 1280x800. This model cannot see images, so no screenshot was taken: read the window with computer_read_tree.')
    for (const [name, input] of [['computer_screenshot', { window_id: 1 }], ['computer_zoom', { window_id: 1, x1: 0, y1: 0, x2: 9, y2: 9 }], ['computer_wait', { window_id: 2, seconds: 0 }]] as const) {
      const result = await run(name, input)
      expect(result.ok).toBe(true)
      expect(result.attachments).toBeUndefined()
      expect(String(result.output)).toMatch(/This model cannot see images/)
    }
    expect(shots).toBe(0)
    // Switching to a model that sees picks screenshots up again, and the budget was not spent.
    vision = true
    expect((await run('computer_screenshot', { window_id: 1 })).attachments).toHaveLength(1)
  })

  it('takes screenshots without limit when no budget is set', async () => {
    const { run } = await setup()
    for (let index = 0; index < 3; index += 1) expect((await run('computer_screenshot', { window_id: 1 })).attachments).toHaveLength(1)
  })

  it('reads the element tree as text only, with the token to use', async () => {
    const { run } = await setup()
    const result = await run('computer_read_tree', { window_id: 1, query: 'Save' })
    expect(result.ok).toBe(true)
    expect(result.attachments).toBeUndefined()
    expect(String(result.output)).toMatch(/snapshot s00000002, 3 of 40 elements/)
    expect(String(result.output)).toMatch(/element_token "s00000002:N"/)
    expect(String(result.output)).toMatch(/stopped at its budget/)
    expect(String(result.output)).toMatch(/\[5\] button "Save"$/)
  })

  it('warns not to act on rows a diff read marks as removed', async () => {
    const { computer, run } = await setup()
    const tree = computer.tree.bind(computer)
    computer.tree = async windowId => ({ ...await tree(windowId), sinceStatus: 'diff' })
    const result = await run('computer_read_tree', { window_id: 1, since: 's00000001' })
    expect(String(result.output)).toMatch(/Rows marked - are gone .* never act on them/)
    expect(String(result.output)).toMatch(/"reindexed:" line/)
  })

  it('aims at an element or a point, never both', async () => {
    const { computer, run } = await setup()
    await run('computer_click', { window_id: 1, element_token: 's00000002:5' })
    await run('computer_type', { window_id: 1, element_token: 's00000002:5', text: 'hi' })
    expect(computer.performed).toEqual([
      { op: 'click', windowId: 1, element: 's00000002:5' },
      { op: 'type', windowId: 1, element: 's00000002:5', text: 'hi' },
    ])
    expect((await run('computer_click', { window_id: 1, element_token: 's00000002:5', x: 1, y: 2 })).ok).toBe(false)
    expect((await run('computer_scroll', { window_id: 1, direction: 'down' })).ok).toBe(false)
    expect(computer.performed).toHaveLength(2)
  })

  it('lists windows with their ids', async () => {
    const { run } = await setup()
    const result = await run('computer_list_windows', {})
    expect(result.output).toBe('window 1 · chrome.exe · "Example" · 1280x800\nwindow 2 · notepad.exe · "notes" · 600x400')
  })

  it('offers one approval per app, keyed by the app that owns the window', async () => {
    const { ctx } = await setup()
    const registry = ctx.get('tools')
    const grantOf = async (name: string, input: unknown) => {
      const definition = registry.list().find(tool => tool.schema.name === name)
      return definition?.grant?.(input, {})
    }
    expect(await grantOf('computer_click', { window_id: 1, x: 0, y: 0 })).toMatchObject({ scope: 'computer:app:chrome.exe' })
    expect(await grantOf('computer_screenshot', { window_id: 1 })).toMatchObject({ scope: 'computer:app:chrome.exe' })
    expect(await grantOf('computer_type', { window_id: 2, text: 'x' })).toMatchObject({ scope: 'computer:app:notepad.exe' })
    expect(await grantOf('computer_list_windows', {})).toMatchObject({ scope: 'computer:windows' })
    expect(await grantOf('computer_open_app', { name: 'Notepad' })).toMatchObject({ scope: 'computer:launch:notepad' })
    // A closed window offers no Session-long scope; the call is asked about on its own.
    expect(await grantOf('computer_click', { window_id: 9, x: 0, y: 0 })).toBeUndefined()
  })

  it('runs a batch of steps in one window and answers with one screenshot', async () => {
    const { computer, run } = await setup()
    const result = await run('computer_steps', { window_id: 1, steps: [
      { action: 'click', element_token: 's00000002:5' },
      { action: 'type', text: 'ada', submit: true },
      { action: 'hover', x: 3, y: 4 },
    ] })
    expect(result.ok).toBe(true)
    expect(computer.performed).toEqual([{ op: 'steps', windowId: 1, steps: [
      { op: 'click', windowId: 1, element: 's00000002:5' },
      { op: 'type', windowId: 1, text: 'ada' },
      { op: 'key', windowId: 1, keys: ['enter'] },
      { op: 'hover', windowId: 1, x: 3, y: 4 },
    ] }])
    expect(result.attachments).toHaveLength(1)
    const bad = await run('computer_steps', { window_id: 1, steps: [{ action: 'click', element_token: 's1:2' }, { action: 'launch' }] })
    expect(bad.ok).toBe(false)
    expect(JSON.stringify(bad)).toMatch(/steps.\[1\].action must be one of/)
    expect(computer.performed).toHaveLength(1)
  })

  it('hovers and invokes menus in a window', async () => {
    const { computer, run } = await setup()
    await run('computer_hover', { window_id: 2, x: 10, y: 20 })
    await run('computer_menu', { window_id: 2, path: ['File', 'Save As...'] })
    expect(computer.performed).toEqual([
      { op: 'hover', windowId: 2, x: 10, y: 20 },
      { op: 'menu', windowId: 2, path: ['File', 'Save As...'] },
    ])
  })

  it('lists apps with their windows and ids, and opens one by id', async () => {
    const { computer, run } = await setup()
    const all = await run('computer_list_apps', {})
    expect(all.output).toBe([
      'Google Chrome · running, window 1 · app_id "Chrome"',
      'Notepad · running, window 2 · app_id "Microsoft.WindowsNotepad"',
      'Calculator · not running · app_id "Microsoft.WindowsCalculator"',
    ].join('\n'))
    expect((await run('computer_list_apps', { query: 'calc' })).output).toBe('Calculator · not running · app_id "Microsoft.WindowsCalculator"')
    await run('computer_open_app', { name: 'Calculator', app_id: 'Microsoft.WindowsCalculator' })
    expect(computer.performed.at(-1)).toEqual({ op: 'launch', app: 'Calculator', id: 'Microsoft.WindowsCalculator' })
  })

  it('reads and writes the clipboard under one approval of its own', async () => {
    const { ctx, computer, run } = await setup()
    expect((await run('computer_clipboard_read', {})).output).toBe('The clipboard holds 6 characters of text.\n\ncopied')
    expect((await run('computer_clipboard_write', { text: 'hello' })).output).toBe('Put 5 characters on the clipboard')
    expect(computer.performed).toEqual([{ op: 'clipboard-read' }, { op: 'clipboard-write', text: 'hello' }])
    const registry = ctx.get('tools')
    const definition = (name: string) => registry.list().find(tool => tool.schema.name === name)
    expect(await definition('computer_clipboard_read')?.grant?.({}, {})).toMatchObject({ scope: 'computer:clipboard' })
    expect(await definition('computer_clipboard_write')?.grant?.({ text: 'x' }, {})).toMatchObject({ scope: 'computer:clipboard' })
    expect(await definition('computer_list_apps')?.grant?.({}, {})).toMatchObject({ scope: 'computer:apps' })
  })

  it('asks before repeating anything but looking and hovering after an interruption', async () => {
    const { ctx } = await setup()
    const interruption = Object.fromEntries(ctx.get('tools').list().map(tool => [tool.schema.name, tool.interruption]))
    expect(interruption).toMatchObject({
      computer_hover: 'retry',
      computer_clipboard_read: 'retry',
      computer_list_apps: 'retry',
      computer_read_tree: 'retry',
      computer_clipboard_write: 'confirm',
      computer_menu: 'confirm',
      computer_steps: 'confirm',
      computer_click: 'confirm',
    })
  })

  it('rejects malformed input before acting', async () => {
    const { computer, run } = await setup()
    expect((await run('computer_scroll', { window_id: 1, x: 0, y: 0, direction: 'sideways' })).ok).toBe(false)
    expect((await run('computer_click', { window_id: 1, x: 'left' })).ok).toBe(false)
    expect(computer.performed).toEqual([])
  })
})

describe('parseKeys', () => {
  it('splits a chord and normalizes case', () => {
    expect(parseKeys('Ctrl + Shift + T')).toEqual(['ctrl', 'shift', 't'])
    expect(parseKeys('Enter')).toEqual(['enter'])
    expect(() => parseKeys(' + ')).toThrow()
  })
})

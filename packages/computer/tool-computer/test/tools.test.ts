import { describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import {
  ComputerError,
  ComputerService,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerScreenshot,
  type ComputerWindow,
} from '@tnega/computer'
import { tools, type ToolResult } from '@tnega/tools'

import { parseKeys, toolComputer } from '../src/index.js'

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

  protected async runAction(action: ComputerAction): Promise<ComputerActionResult> {
    this.performed.push(action)
    if (action.op === 'launch') return { note: `Launched ${action.app}` }
    // Ctrl+W closes the window.
    if (action.op === 'key' && action.keys.join('+') === 'ctrl+w') this.open = this.open.filter(window => window.id !== action.windowId)
    return { note: `${action.op} done`, windowId: action.windowId }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(tools)
  const computer = new FakeComputer(ctx)
  await ctx.plugin(toolComputer, { settleMs: 0 })
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

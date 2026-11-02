import { describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import {
  ComputerService,
  actionWindowId,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerScreenshot,
  type ComputerWindow,
} from '@tnega/computer'

import { appKey, computerTiers, tierOf, type ComputerTiersConfig } from '../src/index.js'

const WINDOWS: ComputerWindow[] = [
  { id: 1, pid: 10, app: 'chrome.exe', title: 'Bank', bounds: { x: 0, y: 0, width: 800, height: 600 }, onScreen: true },
  { id: 2, pid: 20, app: 'notepad.exe', title: 'notes', bounds: { x: 0, y: 0, width: 800, height: 600 }, onScreen: true },
  { id: 3, pid: 30, app: 'Calculator', title: 'Calc', bounds: { x: 0, y: 0, width: 300, height: 400 }, onScreen: true },
]

class FakeComputer extends ComputerService {
  performed: ComputerAction[] = []
  listed: ComputerApp[] | Error = [
    { name: 'Google Chrome', running: true, pid: 10, windowIds: [1] },
    { name: 'Notepad', running: true, pid: 20, windowIds: [2] },
  ]
  listings = 0

  override async apps(): Promise<ComputerApp[]> {
    this.listings += 1
    if (this.listed instanceof Error) throw this.listed
    return this.listed
  }

  async windows(): Promise<ComputerWindow[]> {
    return WINDOWS
  }

  async screenshot(windowId: number): Promise<ComputerScreenshot> {
    return { windowId, app: '', title: '', width: 1, height: 1, mediaType: 'image/png', data: '' }
  }

  async zoom(windowId: number): Promise<ComputerScreenshot> {
    return this.screenshot(windowId)
  }

  protected async runAction(action: ComputerAction): Promise<ComputerActionResult> {
    this.performed.push(action)
    const windowId = actionWindowId(action)
    if (action.op === 'steps') return { note: 'batch', windowId: action.windowId, steps: action.steps.map(step => ({ ok: true, note: step.op })) }
    return { note: 'done', ...(windowId !== undefined ? { windowId } : {}) }
  }
}

async function setup(config: ComputerTiersConfig) {
  const ctx = new Context()
  const computer = new FakeComputer(ctx)
  await ctx.plugin(computerTiers, config)
  return computer
}

describe('computer tiers', () => {
  it('names one app one way, whatever the spelling', () => {
    expect(appKey('Notepad')).toBe('notepad')
    expect(appKey('C:\\Windows\\notepad.exe')).toBe('notepad')
    expect(appKey('/Applications/Safari.app')).toBe('safari')
    expect(tierOf('NOTEPAD.EXE', { apps: { notepad: 'look' } })).toBe('look')
    expect(tierOf('chrome.exe', { apps: { notepad: 'look' } })).toBe('full')
    expect(tierOf('chrome.exe', { fallback: 'click' })).toBe('click')
  })

  it('lets every app do everything by default', async () => {
    const computer = await setup({})
    await computer.act({ op: 'type', windowId: 1, text: 'hello' })
    await computer.act({ op: 'key', windowId: 2, keys: ['ctrl', 's'] })
    expect(computer.performed).toHaveLength(2)
  })

  it('refuses every action in a look-only app and says why', async () => {
    const computer = await setup({ apps: { Chrome: 'look' } })
    await expect(computer.act({ op: 'click', windowId: 1, x: 1, y: 1 })).rejects.toMatchObject({ code: 'COMPUTER_DENIED', message: expect.stringMatching(/chrome\.exe is set to "look"/) })
    // Starting an app is not input to it, and its URLs are navigation; other apps are untouched.
    await computer.act({ op: 'launch', app: 'chrome', urls: ['https://example.com'] })
    await computer.act({ op: 'type', windowId: 2, text: 'x' })
    expect(computer.performed.map(action => action.op)).toEqual(['launch', 'type'])
  })

  it('lets a click-only app be clicked but not typed into, step by step', async () => {
    const computer = await setup({ apps: () => ({ 'notepad.exe': 'click' }) })
    await computer.act({ op: 'click', windowId: 2, x: 1, y: 1 })
    await computer.act({ op: 'scroll', windowId: 2, x: 1, y: 1, direction: 'down' })
    await expect(computer.act({ op: 'type', windowId: 2, text: 'x' })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    await expect(computer.act({ op: 'drag', windowId: 2, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    // A batch with one refused step runs none of its steps.
    await expect(computer.act({ op: 'steps', windowId: 2, steps: [
      { op: 'click', windowId: 2, x: 1, y: 1 },
      { op: 'key', windowId: 2, keys: ['enter'] },
    ] })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    expect(computer.performed.map(action => action.op)).toEqual(['click', 'scroll'])
  })

  it('reads the tiers on every action, so a change in Settings applies at once', async () => {
    let apps: Record<string, 'look' | 'click' | 'full'> = {}
    const computer = await setup({ apps: () => apps })
    await computer.act({ op: 'type', windowId: 3, text: '1+1' })
    apps = { calculator: 'look' }
    await expect(computer.act({ op: 'type', windowId: 3, text: '1+1' })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
  })

  it('matches a limit written with the display name from the app list', async () => {
    const computer = await setup({ apps: { 'Google Chrome': 'look' } })
    await expect(computer.act({ op: 'click', windowId: 1, x: 1, y: 1 })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    await expect(computer.act({ op: 'click', windowId: 1, x: 1, y: 1 })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    await computer.act({ op: 'type', windowId: 2, text: 'x' })
    // The owner of a window is looked up once per process.
    expect(computer.listings).toBe(2)
    expect(computer.performed.map(action => action.op)).toEqual(['type'])
  })

  it('refuses when limits are set and the owning app cannot be told', async () => {
    const computer = await setup({ apps: { 'Google Chrome': 'look' } })
    computer.listed = new Error('driver is gone')
    await expect(computer.act({ op: 'type', windowId: 3, text: '1' })).rejects.toMatchObject({ code: 'COMPUTER_DENIED', message: expect.stringMatching(/driver is gone/) })
    // Without limits nothing is looked up.
    const open = await setup({})
    open.listed = new Error('driver is gone')
    await open.act({ op: 'type', windowId: 3, text: '1' })
    expect(open.listings).toBe(0)
  })

  it('leaves the clipboard alone: it belongs to no app', async () => {
    const computer = await setup({ fallback: 'look' })
    await computer.act({ op: 'clipboard-write', text: 'x' })
    expect(computer.performed).toHaveLength(1)
  })
})

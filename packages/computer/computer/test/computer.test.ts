import { describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'

import {
  ComputerError,
  ComputerService,
  type ComputerAction,
  type ComputerActionEvent,
  type ComputerActionResult,
  type ComputerPreActionEvent,
  type ComputerScreenshot,
  type ComputerWindow,
} from '../src/index.js'

const NOTEPAD: ComputerWindow = { id: 7, pid: 70, app: 'notepad.exe', title: 'notes.txt', bounds: { x: 0, y: 0, width: 800, height: 600 }, onScreen: true }

class FakeComputer extends ComputerService {
  performed: ComputerAction[] = []
  open = [NOTEPAD]

  async windows(): Promise<ComputerWindow[]> {
    return this.open
  }

  async screenshot(windowId: number): Promise<ComputerScreenshot> {
    return { windowId, app: 'notepad.exe', title: 'notes.txt', width: 800, height: 600, mediaType: 'image/png', data: '' }
  }

  async zoom(windowId: number): Promise<ComputerScreenshot> {
    return this.screenshot(windowId)
  }

  protected async runAction(action: ComputerAction): Promise<ComputerActionResult> {
    this.performed.push(action)
    if (action.op === 'type' && action.text === 'boom') throw new Error('driver crashed')
    return { note: 'done', ...(action.op === 'launch' ? {} : { windowId: action.windowId }) }
  }
}

describe('ComputerService.act', () => {
  it('lets policy see the target window, rewrite the action and audit every outcome', async () => {
    const ctx = new Context()
    const computer = new FakeComputer(ctx)
    const seen: ComputerPreActionEvent[] = []
    const events: ComputerActionEvent[] = []
    ctx.on('computer/pre-action', (event: ComputerPreActionEvent, next: () => Promise<unknown>) => {
      seen.push({ ...event })
      if (event.action.op === 'click') event.action = { op: 'click', windowId: event.action.windowId, x: 1, y: 1 }
      return next()
    })
    ctx.on('computer/action', (event: ComputerActionEvent) => { events.push(event) })

    await computer.act({ op: 'click', windowId: 7, x: 10, y: 20 })
    await expect(computer.act({ op: 'type', windowId: 7, text: 'boom' })).rejects.toThrow('driver crashed')

    expect(seen[0]?.window?.app).toBe('notepad.exe')
    expect(computer.performed[0]).toEqual({ op: 'click', windowId: 7, x: 1, y: 1 })
    expect(events.map(event => [event.action.op, event.ok, event.error?.code])).toEqual([
      ['click', true, undefined],
      ['type', false, 'COMPUTER_FAILED'],
    ])
  })

  it('refuses a denied action and a closed window without reaching the Provider', async () => {
    const ctx = new Context()
    const computer = new FakeComputer(ctx)
    ctx.on('computer/pre-action', (event: ComputerPreActionEvent, next: () => Promise<unknown>) => {
      if (event.action.op === 'key') event.deny = 'no shortcuts here'
      return next()
    })
    await expect(computer.act({ op: 'key', windowId: 7, keys: ['ctrl', 's'] })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    await expect(computer.act({ op: 'click', windowId: 99, x: 0, y: 0 })).rejects.toBeInstanceOf(ComputerError)
    await expect(computer.act({ op: 'click', windowId: 99, x: 0, y: 0 })).rejects.toMatchObject({ code: 'COMPUTER_NO_WINDOW' })
    expect(computer.performed).toEqual([])
  })

  it('refuses a policy rewrite that moves the action to another window', async () => {
    const ctx = new Context()
    const computer = new FakeComputer(ctx)
    ctx.on('computer/pre-action', (event: ComputerPreActionEvent, next: () => Promise<unknown>) => {
      if (event.action.op === 'click') event.action = { ...event.action, windowId: 8 }
      return next()
    })
    await expect(computer.act({ op: 'click', windowId: 7, x: 0, y: 0 })).rejects.toMatchObject({ code: 'COMPUTER_DENIED' })
    expect(computer.performed).toEqual([])
  })

  it('keeps a completed action completed when an audit listener fails', async () => {
    const ctx = new Context()
    const computer = new FakeComputer(ctx)
    const outcomes: boolean[] = []
    ctx.on('computer/action', (event: ComputerActionEvent) => {
      outcomes.push(event.ok)
      throw new Error('audit log is full')
    })
    expect(await computer.act({ op: 'click', windowId: 7, x: 0, y: 0 })).toEqual({ note: 'done', windowId: 7 })
    expect(outcomes).toEqual([true])
  })

  it('refuses a policy rewrite that aims at both an element and a point, or at neither', async () => {
    const ctx = new Context()
    const computer = new FakeComputer(ctx)
    // Policy rewrites (and tool input) are untyped at run time; act() checks the aim again.
    ctx.on('computer/pre-action', (event: ComputerPreActionEvent, next: () => Promise<unknown>) => {
      if (event.action.op === 'click') Object.assign(event.action, { x: 1, y: 1 })
      if (event.action.op === 'scroll') { Reflect.deleteProperty(event.action, 'x'); Reflect.deleteProperty(event.action, 'y') }
      return next()
    })
    await expect(computer.act({ op: 'click', windowId: 7, element: 's1:2' })).rejects.toThrow(/not both/)
    await expect(computer.act({ op: 'scroll', windowId: 7, x: 1, y: 1, direction: 'down' })).rejects.toThrow(/element or both x and y/)
    expect(computer.performed).toEqual([])
  })

  it('has no element tree unless the Provider brings one', async () => {
    const computer = new FakeComputer(new Context())
    await expect(computer.tree(7)).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE' })
  })

  it('launches without a target window', async () => {
    const computer = new FakeComputer(new Context())
    expect(await computer.act({ op: 'launch', app: 'notepad' })).toEqual({ note: 'done' })
  })
})

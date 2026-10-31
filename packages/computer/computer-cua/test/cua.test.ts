import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import '@tnega/computer'

import { computerCua, driverCall, findDriver, launchedWindow, readResult, type DriverConnection, type DriverResult } from '../src/index.js'

const WINDOWS = {
  windows: [
    { window_id: 1, pid: 10, app_name: 'Chromium-browser', title: 'Example', bounds: { x: 0, y: 0, width: 1280, height: 800 }, is_on_screen: true, z_index: 0 },
    { window_id: 2, pid: 20, app_name: 'xterm', title: 'shell', bounds: { x: 5, y: 5, width: 600, height: 400 }, is_on_screen: true, z_index: 3 },
    { window_id: 3, pid: 30, app_name: 'cua-driver', title: 'Cua.AgentCursorOverlay.default', is_on_screen: true, z_index: 9 },
  ],
}

function ok(structured: Record<string, unknown> = {}, extra: Partial<DriverResult> = {}): DriverResult {
  return { isError: false, text: 'ok', structured, ...extra }
}

/** A driver that records calls and answers from a script. */
function fakeDriver(answer: (name: string, args: Record<string, unknown>) => DriverResult) {
  const calls: Array<[string, Record<string, unknown>]> = []
  let closed = false
  const connection: DriverConnection = {
    async call(name, args) {
      calls.push([name, args])
      return answer(name, args)
    },
    async close() { closed = true },
  }
  return { calls, connection, closed: () => closed }
}

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A file that passes the executable check, standing in for the real binary. */
async function driverFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-cua-'))
  temps.push(dir)
  const file = join(dir, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')
  await writeFile(file, '')
  await chmod(file, 0o755)
  return file
}

async function mount(answer: (name: string, args: Record<string, unknown>) => DriverResult) {
  const driver = fakeDriver(answer)
  const ctx = new Context()
  const fiber = await ctx.plugin(computerCua, { driverPath: await driverFile(), connect: async () => driver.connection })
  return { driver, computer: ctx.get('computer'), fiber }
}

const IMAGE = { mediaType: 'image/png', data: 'cG5n' }

describe('computer-cua', () => {
  it('lists windows front-most first and hides the driver\'s own overlay', async () => {
    const { computer } = await mount(() => ok(WINDOWS))
    const windows = await computer.windows()
    expect(windows.map(window => [window.id, window.app])).toEqual([[2, 'xterm'], [1, 'Chromium-browser']])
    expect(windows[1]?.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  })

  it('captures a window before the first pixel action and retries in front when background input is refused', async () => {
    const { driver, computer } = await mount((name, args) => {
      if (name === 'list_windows') return ok(WINDOWS)
      if (name === 'get_window_state') return ok({ screenshot_width: 1280, screenshot_height: 800, window_title: 'Example' }, { image: IMAGE })
      if (name === 'click' && args.delivery_mode !== 'foreground') return { isError: true, text: 'no background route', structured: { code: 'background_unavailable' } }
      return ok({}, { text: 'Clicked' })
    })
    const result = await computer.act({ op: 'click', windowId: 1, x: 40, y: 60 })
    expect(result).toEqual({ note: 'Clicked', windowId: 1 })
    expect(driver.calls.filter(([name]) => name !== 'list_windows')).toEqual([
      ['get_window_state', { pid: 10, window_id: 1, include_accessibility_tree: false }],
      ['click', { pid: 10, window_id: 1, x: 40, y: 60 }],
      ['click', { pid: 10, window_id: 1, x: 40, y: 60, delivery_mode: 'foreground' }],
    ])
    await computer.act({ op: 'click', windowId: 1, x: 1, y: 1 })
    expect(driver.calls.filter(([name]) => name === 'get_window_state')).toHaveLength(1)
  })

  it('does not resend input it could not confirm, since the first attempt may have landed', async () => {
    const { driver, computer } = await mount((name, args) => {
      if (name === 'list_windows') return ok(WINDOWS)
      if (name === 'get_window_state') return ok({ screenshot_width: 1280, screenshot_height: 800 }, { image: IMAGE })
      return ok(
        { delivery: { mode: args.delivery_mode ?? 'background' }, effect: 'unverifiable', escalation: { reason: 'delivery_failed', target: 'foreground' } },
        { text: 'Sent in the background, not verified' },
      )
    })
    const result = await computer.act({ op: 'type', windowId: 1, text: 'hi' })
    // Chromium accepts posted text, so a retry would type it twice.
    expect(driver.calls.filter(([name]) => name === 'type_text')).toEqual([['type_text', { pid: 10, window_id: 1, text: 'hi' }]])
    expect(result.windowId).toBe(1)
    expect(result.note).toBe('Sent in the background, not verified\n(The driver sent this in the background but could not confirm it took effect. Check the screenshot before repeating it.)')
  })

  it('retries in front only when the driver refuses the event kind, and leaves a confirmed effect alone', async () => {
    const refused = await mount((name, args) => {
      if (name === 'list_windows') return ok(WINDOWS)
      if (name === 'get_window_state') return ok({}, { image: IMAGE })
      // The driver refuses the real background attempt; the escalation delivers it.
      return args.delivery_mode === 'foreground'
        ? ok({ delivery: { mode: 'foreground' }, effect: 'verified' }, { text: 'Typed in front' })
        : { isError: true, text: 'no background route for text_input', structured: { code: 'background_unavailable' } }
    })
    expect((await refused.computer.act({ op: 'type', windowId: 1, text: 'hi' })).note).toBe('Typed in front')
    expect(refused.driver.calls.filter(([name]) => name === 'type_text')).toEqual([
      ['type_text', { pid: 10, window_id: 1, text: 'hi' }],
      ['type_text', { pid: 10, window_id: 1, text: 'hi', delivery_mode: 'foreground' }],
    ])

    const confirmed = await mount(name => {
      if (name === 'list_windows') return ok(WINDOWS)
      if (name === 'get_window_state') return ok({}, { image: IMAGE })
      return ok({ delivery: { mode: 'background' }, effect: 'verified' }, { text: 'Typed' })
    })
    expect((await confirmed.computer.act({ op: 'type', windowId: 1, text: 'hi' })).note).toBe('Typed')
    expect(confirmed.driver.calls.filter(([name]) => name === 'type_text')).toHaveLength(1)
  })

  it('restores a minimized window before reading it', async () => {
    let restored = false
    const { driver, computer } = await mount((name) => {
      if (name === 'list_windows') return ok(WINDOWS)
      if (name === 'bring_to_front') { restored = true; return ok({}, { text: 'brought forward' }) }
      if (name === 'get_window_state') return restored
        ? ok({ screenshot_width: 800, screenshot_height: 600 }, { image: IMAGE })
        // The real driver answers 200-style, with the reason in structured.screenshot_error.
        : ok({ screenshot_error: 'screenshot unavailable: cannot capture minimized window 0x1' }, { text: 'screenshot unavailable' })
      return ok({}, { text: 'ok' })
    })
    const shot = await computer.screenshot(1)
    expect(shot.width).toBe(800)
    expect(driver.calls.map(([name]) => name)).toEqual(['list_windows', 'get_window_state', 'bring_to_front', 'get_window_state'])
  })

  it('reports a driver refusal as a failure with its code', async () => {
    const { computer } = await mount(name => name === 'list_windows'
      ? ok(WINDOWS)
      : name === 'get_window_state' ? ok({}, { image: IMAGE }) : { isError: true, text: 'target is elevated', structured: { code: 'uipi_blocked' } })
    await expect(computer.act({ op: 'type', windowId: 2, text: 'hi' })).rejects.toThrow(/uipi_blocked.*target is elevated/)
  })

  it('returns a screenshot in window pixels', async () => {
    const { computer } = await mount(name => name === 'list_windows'
      ? ok(WINDOWS)
      : ok({ screenshot_width: 640, screenshot_height: 400, window_title: 'Example' }, { image: IMAGE }))
    expect(await computer.screenshot(1)).toEqual({
      windowId: 1, app: 'Chromium-browser', title: 'Example', width: 640, height: 400, mediaType: 'image/png', data: 'cG5n',
    })
  })

  it('fails closed with an install hint when no driver is installed', async () => {
    const ctx = new Context()
    await ctx.plugin(computerCua, { driverPath: join(tmpdir(), 'no-such-cua-driver') })
    await expect(ctx.get('computer').windows()).rejects.toMatchObject({ code: 'COMPUTER_UNAVAILABLE', message: expect.stringMatching(/cua-driver is not installed/) })
  })

  it('stops the driver when the plugin is disposed', async () => {
    const { driver, computer, fiber } = await mount(() => ok(WINDOWS))
    await computer.windows()
    await fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(driver.closed()).toBe(true)
  })
})

describe('driverCall', () => {
  it('maps keys to press_key or hotkey and rejects a chord with two plain keys', () => {
    expect(driverCall({ op: 'key', windowId: 1, keys: ['Enter'] }, 5)).toEqual({ tool: 'press_key', args: { pid: 5, window_id: 1, key: 'enter' } })
    expect(driverCall({ op: 'key', windowId: 1, keys: ['ctrl', 'shift', 't'] }, 5)).toEqual({ tool: 'hotkey', args: { pid: 5, window_id: 1, keys: ['ctrl', 'shift', 't'] } })
    expect(() => driverCall({ op: 'key', windowId: 1, keys: ['a', 'b'] }, 5)).toThrow(/non-modifier/)
  })

  it('sends launch URLs to the default browser for a name, and to the app for a full path', () => {
    // A bare name leaves the choice of browser to the system.
    expect(driverCall({ op: 'launch', app: 'notepad' }, 0)).toEqual({ tool: 'launch_app', args: { name: 'notepad' } })
    expect(driverCall({ op: 'launch', app: 'chrome', urls: ['https://example.com'] }, 0))
      .toEqual({ tool: 'launch_app', args: { name: 'chrome', urls: ['https://example.com'] } })
    // A named executable runs with the URLs as its own arguments, so the named browser opens them.
    expect(driverCall({ op: 'launch', app: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', urls: ['https://example.com'] }, 0))
      .toEqual({ tool: 'launch_app', args: { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', additional_arguments: ['https://example.com'] } })
    expect(driverCall({ op: 'launch', app: 'msedge.exe' }, 0)).toEqual({ tool: 'launch_app', args: { name: 'msedge.exe' } })
  })
})

describe('launchedWindow', () => {
  it('names the window only when the driver reports exactly one', () => {
    expect(launchedWindow({ windows: [{ window_id: 42, title: 'Notepad' }] })).toBe(42)
    expect(launchedWindow({ windows: [{ window_id: 1 }, { window_id: 2 }] })).toBeUndefined()
    expect(launchedWindow({})).toBeUndefined()
  })
})

describe('findDriver', () => {
  it('uses an explicit path only when it exists', async () => {
    const file = await driverFile()
    expect(await findDriver(file, {})).toBe(file)
    expect(await findDriver(join(tmpdir(), 'missing-cua-driver'), {})).toBeUndefined()
  })

  it('reads an MCP result without trusting its shape', () => {
    expect(readResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x', mimeType: 'image/jpeg' }], structuredContent: { k: 1 } }))
      .toEqual({ isError: false, text: 'a', image: { mediaType: 'image/jpeg', data: 'x' }, structured: { k: 1 } })
    expect(readResult(null)).toEqual({ isError: false, text: '', structured: {} })
  })
})

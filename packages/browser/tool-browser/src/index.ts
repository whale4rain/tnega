import type { Context } from '@tnega/core'
import {
  BrowserError,
  type BrowserAction,
  type BrowserConsoleEntry,
  type BrowserService,
} from '@tnega/browser'
import { withAttachments, type ToolDefinition, type ToolExecuteOptions, type ToolsService } from '@tnega/tools'

/** Tools that only observe the page. */
export const BROWSER_OBSERVE_TOOLS: readonly string[] = [
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
]

/** Tools that change the page or run code in it. */
export const BROWSER_ACT_TOOLS: readonly string[] = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_reload',
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_select_option',
  'browser_press_key',
  'browser_scroll',
  'browser_wait_for',
  'browser_resize',
  'browser_evaluate',
]

export const DEFAULT_TOOL_BROWSER_NAMES: readonly string[] = [...BROWSER_OBSERVE_TOOLS, ...BROWSER_ACT_TOOLS]

export interface ToolBrowserConfig {
  /** Leave these tools unregistered. */
  disabled?: readonly string[]
  /** Append the page snapshot to every action result (default true). */
  snapshotAfterAction?: boolean
  timeoutMs?: number
}

type Args = Record<string, unknown>

function args(input: unknown): Args {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Args : {}
}

function text(input: Args, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${key} must be a non-empty string`)
  return value
}

function optionalText(input: Args, key: string): string | undefined {
  const value = input[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function number(input: Args, key: string, fallback?: number): number {
  const value = input[key] ?? fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${key} must be a number`)
  return value
}

const REF = { type: 'string', description: 'Element ref from the latest browser_snapshot, e.g. "e12"' }
const ELEMENT = { type: 'string', description: 'Short human description of the element, for the activity log' }

function formatConsole(entries: readonly BrowserConsoleEntry[]): string {
  return entries.map(entry => `[${entry.type}] ${entry.text}${entry.location ? ` (${entry.location})` : ''}`).join('\n')
}

/**
 * The model-visible browser tools. They only reach the page through
 * `ctx.browser`, so the same tools drive the desktop app's embedded view and a
 * launched browser alike.
 */
export function browserTools(browser: BrowserService, config: ToolBrowserConfig = {}): ToolDefinition[] {
  const snapshotAfter = config.snapshotAfterAction ?? true
  const timeoutMs = config.timeoutMs ?? 60_000

  const act = async (action: BrowserAction, options: ToolExecuteOptions): Promise<string> => {
    const startedAt = Date.now()
    const result = await browser.act(action, options.signal ? { signal: options.signal } : {})
    const lines = [
      ...(result.note ? [result.note] : []),
      `URL: ${result.url}`,
      `Title: ${result.title}`,
    ]
    const problems = browser.console({ since: startedAt - 1, onlyProblems: true })
    if (problems.length) {
      lines.push(`Console errors/warnings since this action (${problems.length}):`, formatConsole(problems.slice(-5)))
    }
    if (snapshotAfter) {
      const snapshot = await browser.snapshot(options.signal ? { signal: options.signal } : {})
      lines.push('Snapshot:', snapshot.snapshot)
    }
    return lines.join('\n')
  }

  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    execute: (input: Args, options: ToolExecuteOptions) => unknown,
  ): ToolDefinition => ({
    schema: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } },
    timeoutMs,
    metadata: { browser: BROWSER_OBSERVE_TOOLS.includes(name) ? 'observe' : 'act' },
    execute: (input, options) => execute(args(input), options),
  })

  return [
    tool('browser_navigate', 'Open a URL in the agent browser, e.g. the dev server (http://localhost:5173). Returns the page snapshot.', {
      url: { type: 'string', description: 'URL; a bare host like localhost:3000 is accepted' },
    }, ['url'], (input, options) => act({ op: 'navigate', url: text(input, 'url') }, options)),
    tool('browser_navigate_back', 'Go back to the previous page.', {}, [], (_input, options) => act({ op: 'back' }, options)),
    tool('browser_reload', 'Reload the current page, e.g. after changing code without hot reload.', {}, [], (_input, options) => act({ op: 'reload' }, options)),
    tool('browser_snapshot', 'Read the current page as an accessibility tree. Elements carry refs like [ref=e12] that the other browser tools take. Prefer this over screenshots for reading content and finding elements.', {}, [], async (_input, options) => {
      const snapshot = await browser.snapshot(options.signal ? { signal: options.signal } : {})
      return `URL: ${snapshot.url}\nTitle: ${snapshot.title}\nSnapshot:\n${snapshot.snapshot}`
    }),
    tool('browser_click', 'Click an element by ref.', {
      ref: REF,
      element: ELEMENT,
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      doubleClick: { type: 'boolean' },
    }, ['ref'], (input, options) => act({
      op: 'click',
      ref: text(input, 'ref'),
      ...(optionalText(input, 'element') ? { element: optionalText(input, 'element')! } : {}),
      ...(input.button === 'right' || input.button === 'middle' ? { button: input.button } : {}),
      ...(input.doubleClick === true ? { doubleClick: true } : {}),
    }, options)),
    tool('browser_hover', 'Hover over an element by ref, e.g. to check hover styles or open a menu.', { ref: REF, element: ELEMENT }, ['ref'], (input, options) => act({ op: 'hover', ref: text(input, 'ref') }, options)),
    tool('browser_type', 'Replace the text of an input, textarea or contenteditable element; optionally press Enter.', {
      ref: REF,
      element: ELEMENT,
      text: { type: 'string' },
      submit: { type: 'boolean', description: 'Press Enter after typing' },
    }, ['ref', 'text'], (input, options) => {
      if (typeof input.text !== 'string') throw new TypeError('text must be a string')
      return act({ op: 'type', ref: text(input, 'ref'), text: input.text, ...(input.submit === true ? { submit: true } : {}) }, options)
    }),
    tool('browser_select_option', 'Choose option(s) in a <select> by value or label.', {
      ref: REF,
      element: ELEMENT,
      values: { type: 'array', items: { type: 'string' } },
    }, ['ref', 'values'], (input, options) => {
      if (!Array.isArray(input.values) || !input.values.every(value => typeof value === 'string')) throw new TypeError('values must be an array of strings')
      return act({ op: 'select', ref: text(input, 'ref'), values: input.values as string[] }, options)
    }),
    tool('browser_press_key', 'Press a key or chord on the focused element, e.g. "Enter", "Escape", "Control+A", "ArrowDown".', {
      key: { type: 'string' },
    }, ['key'], (input, options) => act({ op: 'press', key: text(input, 'key') }, options)),
    tool('browser_scroll', 'Scroll the page with the mouse wheel. Positive deltaY scrolls down.', {
      deltaY: { type: 'number' },
      deltaX: { type: 'number' },
    }, ['deltaY'], (input, options) => act({
      op: 'scroll',
      deltaY: number(input, 'deltaY'),
      ...(input.deltaX !== undefined ? { deltaX: number(input, 'deltaX') } : {}),
    }, options)),
    tool('browser_wait_for', 'Wait until text appears, until text disappears, or for a number of seconds (max 10).', {
      text: { type: 'string' },
      textGone: { type: 'string' },
      time: { type: 'number', description: 'Seconds' },
    }, [], (input, options) => {
      const appear = optionalText(input, 'text')
      const gone = optionalText(input, 'textGone')
      return act({
        op: 'wait',
        ...(appear !== undefined ? { text: appear } : {}),
        ...(gone !== undefined ? { textGone: gone } : {}),
        ...(input.time !== undefined ? { ms: number(input, 'time') * 1000 } : {}),
      }, options)
    }),
    tool('browser_resize', 'Resize the page viewport, e.g. 375x812 to check a mobile layout.', {
      width: { type: 'number' },
      height: { type: 'number' },
    }, ['width', 'height'], (input, options) => act({ op: 'resize', width: number(input, 'width'), height: number(input, 'height') }, options)),
    tool('browser_take_screenshot', 'Capture what the page looks like, to check layout, styling and visual bugs. The image is attached for you to look at; use browser_snapshot to find elements.', {
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page' },
      ref: { ...REF, description: 'Capture only this element' },
    }, [], async (input, options) => {
      const ref = optionalText(input, 'ref')
      const shot = await browser.screenshot({
        ...(options.signal ? { signal: options.signal } : {}),
        ...(input.fullPage === true ? { fullPage: true } : {}),
        ...(ref ? { ref } : {}),
      })
      return withAttachments(
        `Screenshot of ${shot.url}${ref ? ` (element ${ref})` : ''}`,
        [{ type: 'image', mediaType: shot.mediaType, data: shot.data, name: 'screenshot.jpg' }],
      )
    }),
    tool('browser_console_messages', 'Read the page console: logs, warnings, errors and uncaught exceptions.', {
      onlyErrors: { type: 'boolean', description: 'Only errors and warnings' },
      limit: { type: 'number' },
    }, [], input => {
      const entries = browser.console({
        ...(input.onlyErrors === true ? { onlyProblems: true } : {}),
        limit: typeof input.limit === 'number' ? input.limit : 100,
      })
      return entries.length ? formatConsole(entries) : 'No console messages.'
    }),
    tool('browser_network_requests', 'List network requests the page made, with status codes. Useful to spot failing API calls or missing assets.', {
      onlyFailed: { type: 'boolean', description: 'Only failed requests and 4xx/5xx responses' },
      limit: { type: 'number' },
    }, [], input => {
      const entries = browser.network({
        ...(input.onlyFailed === true ? { onlyProblems: true } : {}),
        limit: typeof input.limit === 'number' ? input.limit : 100,
      })
      if (!entries.length) return 'No network requests recorded.'
      return entries.map(entry => `${entry.method} ${entry.url} → ${entry.failure ?? entry.status ?? 'pending'} (${entry.resourceType})`).join('\n')
    }),
    tool('browser_evaluate', 'Run JavaScript in the page and return its JSON value, e.g. "document.title" or "() => getComputedStyle(document.body).fontSize".', {
      function: { type: 'string', description: 'An expression or a () => {...} function' },
    }, ['function'], async (input, options) => {
      const value = await browser.evaluate(text(input, 'function'), options.signal ? { signal: options.signal } : {})
      return value === undefined ? 'undefined' : value
    }),
  ]
}

export const name = 'tool-browser'

export function apply(ctx: Context, config: ToolBrowserConfig = {}): void {
  const registry = ctx.get('tools') as ToolsService
  const disabled = new Set(config.disabled ?? [])
  for (const definition of browserTools(ctx.browser, config)) {
    if (!disabled.has(definition.schema.name)) registry.register(definition)
  }
}

/** Mount: `await ctx.plugin(toolBrowser)`; needs `ctx.tools` and `ctx.browser`. */
export const toolBrowser = {
  name,
  inject: ['tools', 'browser'],
  apply,
}

export { BrowserError }

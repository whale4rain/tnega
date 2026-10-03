import type { Browser, BrowserContext, BrowserType, Page } from 'playwright-core'
import { BrowserError } from '@tnega/browser'

/**
 * Playwright loads only when a browser is first needed, so a runtime without
 * the dependency installed (or that never browses) still starts.
 */
async function chromiumType(): Promise<BrowserType> {
  try {
    return (await import('playwright-core')).chromium
  } catch (error) {
    throw new BrowserError('BROWSER_UNAVAILABLE', 'playwright-core is not installed', { cause: error })
  }
}

/**
 * Where the driven pages (tabs) come from. The host acquires the first page
 * lazily and opens more on demand; `release` frees only what the source
 * itself started.
 */
export interface PageSource {
  /** The first page, starting the browser if needed. */
  acquire(): Promise<Page>
  /** Open another page: a new tab. */
  open(): Promise<Page>
  /** Close a page the source opened. */
  closePage(page: Page): Promise<void>
  /** Show this page to the user, e.g. swap the visible desktop view. */
  activate?(page: Page): Promise<void>
  /** Pages the page opened itself (`target=_blank`, `window.open`). */
  onPopup?(listener: (page: Page) => void): void
  /** Called before anything that needs the page to paint (actions, screenshots). */
  prepare?(page: Page): Promise<void>
  release(): Promise<void>
}

export interface LaunchSourceOptions {
  /** A Chromium-based browser to run; defaults to the system Edge on Windows and Chrome elsewhere. */
  channel?: string
  executablePath?: string
  /** Defaults to false on Windows and macOS so the developer can watch, true elsewhere without a display. */
  headless?: boolean
  viewport?: { width: number; height: number }
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

function defaultChannels(): Array<string | undefined> {
  if (process.platform === 'win32') return ['msedge', 'chrome', undefined]
  if (process.platform === 'darwin') return ['chrome', 'msedge', undefined]
  return ['chrome', undefined]
}

function defaultHeadless(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return false
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

/**
 * A browser the provider starts itself, in a fresh profile. Tries the system
 * Edge / Chrome first so no download is needed, then Playwright's own Chromium.
 */
export function launchPageSource(options: LaunchSourceOptions = {}): PageSource {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  const popupListeners: Array<(page: Page) => void> = []

  const launch = async (): Promise<Browser> => {
    const headless = options.headless ?? defaultHeadless()
    const chromium = await chromiumType()
    if (options.executablePath) return chromium.launch({ executablePath: options.executablePath, headless })
    const channels = options.channel ? [options.channel] : defaultChannels()
    const failures: string[] = []
    for (const channel of channels) {
      try {
        return await chromium.launch({ headless, ...(channel ? { channel } : {}) })
      } catch (error) {
        failures.push(`${channel ?? 'bundled chromium'}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
      }
    }
    throw new BrowserError(
      'BROWSER_UNAVAILABLE',
      `no Chromium-based browser could be started (${failures.join('; ')}). Install Edge or Chrome, or run \`npx playwright install chromium\`.`,
    )
  }

  const ensureContext = async (): Promise<BrowserContext> => {
    if (!browser?.isConnected()) {
      browser = await launch()
      context = undefined
    }
    if (!context) {
      const created = await browser.newContext({ viewport: options.viewport ?? DEFAULT_VIEWPORT })
      created.on('page', page => {
        // Pages we open ourselves have no opener; popups do.
        void page.opener().then(opener => {
          if (opener) for (const listener of popupListeners) listener(page)
        })
      })
      context = created
    }
    return context
  }

  return {
    async acquire() {
      const current = await ensureContext()
      return current.pages().find(page => !page.isClosed()) ?? current.newPage()
    },
    async open() {
      return (await ensureContext()).newPage()
    },
    async closePage(page) {
      await page.close().catch(() => {})
    },
    onPopup(listener) {
      popupListeners.push(listener)
    },
    async release() {
      const current = browser
      browser = undefined
      context = undefined
      await current?.close().catch(() => {})
    },
  }
}

export interface CdpSourceOptions {
  /** `http://127.0.0.1:<port>` of a Chromium remote-debugging endpoint. */
  endpoint(): Promise<string>
  /** CDP target id of the first page this source may drive. */
  targetId(): Promise<string>
  /** Create another page in the host app (a new tab) and return its target id. */
  openTarget?(): Promise<string>
  /** Show this target to the user. */
  activateTarget?(targetId: string): Promise<void>
  /** Destroy a target the host created. */
  closeTarget?(targetId: string): Promise<void>
  /** Make the page paint before acting, e.g. show the desktop browser panel. */
  prepare?(): Promise<void>
}

async function targetIdOf(page: Page): Promise<string | undefined> {
  const session = await page.context().newCDPSession(page)
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo') as { targetInfo: { targetId: string } }
    return targetInfo.targetId
  } finally {
    await session.detach().catch(() => {})
  }
}

/**
 * Pages that live in another Chromium (the Electron app's embedded views),
 * reached over CDP. Only targets the host app hands out are ever driven; every
 * other page of that browser — the app's own UI — is ignored.
 */
export function cdpPageSource(options: CdpSourceOptions): PageSource {
  let browser: Browser | undefined
  const targets = new WeakMap<Page, string>()

  const connect = async (): Promise<Browser> => {
    if (browser?.isConnected()) return browser
    try {
      // The endpoint also contains the host UI: default context overrides
      // would change its color scheme, motion preferences and focus behavior.
      browser = await (await chromiumType()).connectOverCDP(await options.endpoint(), { noDefaults: true })
      return browser
    } catch (error) {
      throw new BrowserError('BROWSER_UNAVAILABLE', `could not attach to the in-app browser: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  const find = async (wanted: string): Promise<Page> => {
    const current = await connect()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      for (const candidate of current.contexts().flatMap(context => context.pages())) {
        if (await targetIdOf(candidate).catch(() => undefined) === wanted) {
          targets.set(candidate, wanted)
          return candidate
        }
      }
      // A view created just now can take a moment to surface as a target.
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new BrowserError('BROWSER_UNAVAILABLE', 'the in-app browser page was not found')
  }

  return {
    async acquire() {
      return find(await options.targetId())
    },
    async open() {
      if (!options.openTarget) throw new BrowserError('BROWSER_FAILED', 'this browser cannot open tabs')
      return find(await options.openTarget())
    },
    async closePage(page) {
      const id = targets.get(page)
      if (id && options.closeTarget) await options.closeTarget(id)
    },
    async activate(page) {
      const id = targets.get(page)
      if (id) await options.activateTarget?.(id)
    },
    async prepare() {
      await options.prepare?.()
    },
    async release() {
      const current = browser
      browser = undefined
      // Dropping the connection is enough; the embedded views belong to the host app.
      await current?.close().catch(() => {})
    },
  }
}

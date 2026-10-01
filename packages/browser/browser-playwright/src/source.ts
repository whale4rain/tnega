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
 * Where the driven page comes from. The host acquires lazily on first use and
 * again whenever the page has closed; `release` frees only what the source
 * itself started.
 */
export interface PageSource {
  acquire(): Promise<Page>
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
  let page: Page | undefined

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

  return {
    async acquire() {
      if (page && !page.isClosed()) return page
      if (!browser?.isConnected()) {
        browser = await launch()
        context = undefined
      }
      context ??= await browser.newContext({ viewport: options.viewport ?? DEFAULT_VIEWPORT })
      page = await context.newPage()
      return page
    },
    async release() {
      const current = browser
      browser = undefined
      context = undefined
      page = undefined
      await current?.close().catch(() => {})
    },
  }
}

export interface CdpSourceOptions {
  /** `http://127.0.0.1:<port>` of a Chromium remote-debugging endpoint. */
  endpoint(): Promise<string>
  /** CDP target id of the one page this source may drive. */
  targetId(): Promise<string>
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
 * A page that already exists in another Chromium (the Electron app's embedded
 * view), reached over CDP. Only the page with the given target id is ever
 * driven; every other page of that browser — the app's own UI — is ignored.
 */
export function cdpPageSource(options: CdpSourceOptions): PageSource {
  let browser: Browser | undefined
  let page: Page | undefined
  return {
    async acquire() {
      if (page && !page.isClosed() && browser?.isConnected()) return page
      if (!browser?.isConnected()) {
        try {
          browser = await (await chromiumType()).connectOverCDP(await options.endpoint())
        } catch (error) {
          throw new BrowserError('BROWSER_UNAVAILABLE', `could not attach to the in-app browser: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
      const wanted = await options.targetId()
      for (let attempt = 0; attempt < 20; attempt += 1) {
        for (const candidate of browser.contexts().flatMap(context => context.pages())) {
          if (await targetIdOf(candidate).catch(() => undefined) === wanted) {
            page = candidate
            return page
          }
        }
        // A view created just now can take a moment to surface as a target.
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new BrowserError('BROWSER_UNAVAILABLE', 'the in-app browser page was not found')
    },
    async prepare() {
      await options.prepare?.()
    },
    async release() {
      page = undefined
      const current = browser
      browser = undefined
      // Dropping the connection is enough; the embedded view belongs to the host app.
      await current?.close().catch(() => {})
    },
  }
}

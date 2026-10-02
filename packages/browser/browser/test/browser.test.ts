import { describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'

import {
  BrowserError,
  BrowserService,
  isLocalUrl,
  normalizeBrowserUrl,
  type BrowserAction,
  type BrowserActionEvent,
  type BrowserActionResult,
  type BrowserPreActionEvent,
  type BrowserScreenshot,
  type BrowserSnapshot,
} from '../src/index.js'

class FakeBrowser extends BrowserService {
  performed: BrowserAction[] = []
  private _url = 'about:blank'

  page() {
    return { url: this._url, title: '' }
  }

  tabs() {
    return [{ id: 't1', url: this._url, title: '', active: true }]
  }

  protected async runAction(action: BrowserAction): Promise<BrowserActionResult> {
    this.performed.push(action)
    if (action.op === 'click' && action.ref === 'gone') throw new BrowserError('BROWSER_STALE_REF', 'ref gone is not on the page')
    if (action.op === 'navigate') this._url = action.url
    return { url: this._url, title: '' }
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return { url: this._url, title: '', snapshot: '', truncated: false }
  }

  async screenshot(): Promise<BrowserScreenshot> {
    return { url: this._url, title: '', mediaType: 'image/jpeg', data: '' }
  }

  console() { return [] }
  network() { return [] }
  async evaluate() { return undefined }
}

describe('BrowserService.act', () => {
  it('lets policy rewrite an action and reports every outcome', async () => {
    const ctx = new Context()
    const browser = new FakeBrowser(ctx)
    const events: BrowserActionEvent[] = []
    ctx.on('browser/pre-action', (event: BrowserPreActionEvent, next: () => Promise<unknown>) => {
      if (event.action.op === 'navigate') event.action = { op: 'navigate', url: 'http://localhost:5173/' }
      return next()
    })
    ctx.on('browser/action', (event: BrowserActionEvent) => { events.push(event) })

    await browser.act({ op: 'navigate', url: 'http://localhost:5173' })
    await expect(browser.act({ op: 'click', ref: 'gone' })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })

    expect(browser.performed[0]).toEqual({ op: 'navigate', url: 'http://localhost:5173/' })
    expect(events.map(event => [event.action.op, event.ok, event.error?.code])).toEqual([
      ['navigate', true, undefined],
      ['click', false, 'BROWSER_STALE_REF'],
    ])
    expect(events[0]!.page.url).toBe('http://localhost:5173/')
  })

  it('refuses a denied action without reaching the provider', async () => {
    const ctx = new Context()
    const browser = new FakeBrowser(ctx)
    ctx.on('browser/pre-action', (event: BrowserPreActionEvent, next: () => Promise<unknown>) => {
      event.deny = 'only local pages'
      return next()
    })

    await expect(browser.act({ op: 'navigate', url: 'https://example.com' })).rejects.toMatchObject({
      code: 'BROWSER_DENIED',
      message: 'only local pages',
    })
    expect(browser.performed).toEqual([])
  })
})

describe('url helpers', () => {
  it('recognises local development hosts', () => {
    expect(isLocalUrl('http://localhost:5173/app')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isLocalUrl('http://[::1]:8080')).toBe(true)
    expect(isLocalUrl('https://shop.test')).toBe(true)
    expect(isLocalUrl('http://api.localhost')).toBe(true)
    expect(isLocalUrl('about:blank')).toBe(true)
    expect(isLocalUrl('https://example.com')).toBe(false)
    expect(isLocalUrl('http://localhost.evil.com')).toBe(false)
    expect(isLocalUrl('not a url')).toBe(false)
  })

  it('adds a scheme to bare hosts', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeBrowserUrl('127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com')
    expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
  })
})

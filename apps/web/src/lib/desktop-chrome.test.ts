// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundBehind, cssColorToHex, markWindowControls, useDesktopChrome, windowControlsSide } from './desktop-chrome'

it('reserves native controls only in the header at the top-right edge', () => {
  const root = document.createElement('div')
  root.innerHTML = '<header class="conv-header"></header><aside class="workbench"><div class="wb-header"><div class="wb-rail"></div></div></aside>'
  const conversation = root.children[0]
  const drawer = root.querySelector('.wb-header')
  if (!conversation || !drawer) throw new Error('missing headers')
  conversation.getBoundingClientRect = () => new DOMRect(0, 0, 700, 58)
  drawer.getBoundingClientRect = () => new DOMRect(708, 6, 564, 36)
  const workbench = root.querySelector('.workbench')
  if (!workbench) throw new Error('missing workbench')
  workbench.getBoundingClientRect = () => new DOMRect(700, 0, 580, 820)
  markWindowControls(root, 1280)
  expect(conversation.classList.contains('window-controls-header')).toBe(false)
  expect(drawer.classList.contains('window-controls-header')).toBe(true)
  // The header keeps only the room the controls still take from its own end: the Workbench holds
  // that end here, so nothing is left of the controls over it.
  expect((conversation as HTMLElement).style.getPropertyValue('--window-controls-gap')).toBe('580px')
  expect((drawer as HTMLElement).style.getPropertyValue('--window-controls-gap')).toBe('0px')
  conversation.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 58)
  drawer.getBoundingClientRect = () => new DOMRect(700, 58, 580, 58)
  markWindowControls(root, 1280)
  expect(conversation.classList.contains('window-controls-header')).toBe(true)
  expect(drawer.classList.contains('window-controls-header')).toBe(false)
  expect((conversation as HTMLElement).style.getPropertyValue('--window-controls-gap')).toBe('0px')
})

it('keeps the top-left header clear of the macOS traffic lights instead', () => {
  expect(windowControlsSide('darwin')).toBe('left')
  expect(windowControlsSide('win32')).toBe('right')
  expect(windowControlsSide('linux')).toBe('right')
  const root = document.createElement('div')
  root.innerHTML = '<div class="sidebar-top"></div><header class="conv-header"></header>'
  const [sidebar, conversation] = [...root.children]
  if (!sidebar || !conversation) throw new Error('missing headers')
  // The sidebar is a card inset 10px from the window edge, still under the lights.
  sidebar.getBoundingClientRect = () => new DOMRect(10, 0, 243, 32)
  conversation.getBoundingClientRect = () => new DOMRect(264, 0, 760, 32)
  markWindowControls(root, 1280, 'left')
  expect(sidebar.classList.contains('window-controls-header-start')).toBe(true)
  expect(conversation.classList.contains('window-controls-header-start')).toBe(false)
  expect(conversation.classList.contains('window-controls-header')).toBe(false)
  // With the sidebar collapsed, the conversation header reaches the corner.
  sidebar.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
  conversation.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 32)
  markWindowControls(root, 1280, 'left')
  expect(sidebar.classList.contains('window-controls-header-start')).toBe(false)
  expect(conversation.classList.contains('window-controls-header-start')).toBe(true)
})

it('marks a header again when its size settles after mounting', async () => {
  const resized: Array<() => void> = []
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized.push(callback) } observe() {} disconnect() {} })
  vi.stubGlobal('tnegaDesktop', { setTitleBarColors: () => {}, platform: 'darwin' })
  document.body.innerHTML = '<div class="sidebar-top"></div>'
  const sidebar = document.querySelector('.sidebar-top')
  if (!sidebar) throw new Error('missing header')
  // Mounted before its panel has a size: nothing to clear yet.
  sidebar.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
  renderHook(() => useDesktopChrome('sessions'))
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(sidebar.classList.contains('window-controls-header-start')).toBe(false)
  // The panel settles with no DOM change and no window resize.
  sidebar.getBoundingClientRect = () => new DOMRect(10, 0, 243, 32)
  for (const callback of resized) callback()
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(sidebar.classList.contains('window-controls-header-start')).toBe(true)
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('keeps the page marked through a layout change instead of clearing and re-adding it', async () => {
  vi.stubGlobal('tnegaDesktop', { setTitleBarColors: () => {}, platform: 'win32' })
  document.body.innerHTML = '<header class="conv-header"></header>'
  const header = document.querySelector('.conv-header')
  if (!header) throw new Error('missing header')
  header.getBoundingClientRect = () => new DOMRect(0, 0, window.innerWidth, 32)
  document.elementFromPoint = () => header
  const { rerender } = renderHook(({ key }) => useDesktopChrome(key), { initialProps: { key: 'sessions:none' } })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(header.classList.contains('window-controls-header')).toBe(true)
  // Opening the Workbench: nothing may drop the clearance, even for a frame.
  rerender({ key: 'sessions:files' })
  expect(document.documentElement.classList.contains('desktop-chrome')).toBe(true)
  expect(header.classList.contains('window-controls-header')).toBe(true)
  cleanup()
  expect(document.documentElement.classList.contains('desktop-chrome')).toBe(false)
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** The bars only: the corner itself often holds neither while a panel folds. */
function barsOnScreen(open: boolean) {
  document.body.innerHTML = `<div class="app${open ? ' workbench-open' : ''}"><header class="conv-header"></header>`
    + '<aside class="workbench"><div class="wb-titlebar"></div></aside></div>'
  const header = document.querySelector('.conv-header') as HTMLElement
  const strip = document.querySelector('.wb-titlebar') as HTMLElement
  const app = document.querySelector('.app') as HTMLElement
  header.style.backgroundColor = 'rgb(10, 20, 30)'
  strip.style.backgroundColor = 'rgb(30, 20, 10)'
  // jsdom gives every element an empty rect list; in the desktop app the bars have a size.
  strip.getClientRects = (() => [new DOMRect(0, 0, 500, 32)]) as unknown as () => DOMRectList
  header.getBoundingClientRect = () => new DOMRect(0, 0, window.innerWidth, 32)
  // Mid-fold the point lands on the frame between the two bars.
  document.elementFromPoint = () => app
  return { app, strip }
}

describe('the controls colour', () => {
  it('comes from the Workbench title strip while its panel holds the corner', async () => {
    const colors: Array<{ background: string, foreground: string }> = []
    vi.stubGlobal('tnegaDesktop', { setTitleBarColors: (value: { background: string, foreground: string }) => colors.push(value), platform: 'win32' })
    barsOnScreen(true)
    renderHook(() => useDesktopChrome('sessions:files'))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(colors.at(-1)?.background).toBe('#1e140a')
    cleanup()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('comes from the view header while the Workbench is folded', async () => {
    const colors: Array<{ background: string, foreground: string }> = []
    vi.stubGlobal('tnegaDesktop', { setTitleBarColors: (value: { background: string, foreground: string }) => colors.push(value), platform: 'win32' })
    barsOnScreen(false)
    renderHook(() => useDesktopChrome('sessions:files'))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(colors.at(-1)?.background).toBe('#0a141e')
    cleanup()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })
})

describe('cssColorToHex', () => {  it('converts computed colours and skips transparent ones', () => {
    expect(cssColorToHex('rgb(246, 245, 241)')).toBe('#f6f5f1')
    expect(cssColorToHex('rgba(20, 22, 21, 1)')).toBe('#141615')
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeUndefined()
    expect(cssColorToHex(' #1B1E1D')).toBe('#1b1e1d')
    expect(cssColorToHex('transparent')).toBeUndefined()
  })
})

/** jsdom has no pseudo-element styles: `::before` reads as absent unless a test gives it one. */
const realStyle = window.getComputedStyle.bind(window)
let before: Partial<CSSStyleDeclaration> | undefined
beforeEach(() => {
  before = undefined
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => pseudo
    ? { content: 'none', ...before } as CSSStyleDeclaration
    : realStyle(element))
})

describe('backgroundBehind', () => {
  it('counts a glass ::before that covers its bar, as the Glass everywhere header draws it', () => {
    const page = document.createElement('div')
    page.style.backgroundColor = 'rgb(25, 25, 25)'
    const header = document.createElement('header')
    page.appendChild(header)
    document.body.appendChild(page)
    before = { content: '""', position: 'absolute', top: '0px', right: '0px', bottom: '0px', left: '0px', backgroundColor: 'color(srgb 0.164706 0.164706 0.164706 / 0.8)' }
    expect(backgroundBehind(header, '#ffffff')).toBe('#272727')
    // A small decoration (a dot, an underline) is not the bar's surface.
    before = { ...before, top: '12px' }
    expect(backgroundBehind(header, '#ffffff')).toBe('#191919')
  })

  it('walks up to the first opaque background', () => {
    const outer = document.createElement('div')
    outer.style.backgroundColor = 'rgb(27, 30, 29)'
    const inner = document.createElement('span')
    outer.appendChild(inner)
    document.body.appendChild(outer)
    expect(backgroundBehind(inner, '#ffffff')).toBe('#1b1e1d')
    expect(backgroundBehind(null, '#ffffff')).toBe('#ffffff')
  })
})

describe('backgroundBehind with an overlay', () => {
  it('mixes a translucent scrim over the page so the window controls dim with it', () => {
    const page = document.createElement('div')
    page.style.backgroundColor = 'rgb(200, 200, 200)'
    const scrim = document.createElement('div')
    scrim.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'
    page.appendChild(scrim)
    document.body.appendChild(page)
    expect(backgroundBehind(scrim, '#ffffff')).toBe('#646464')
    expect(cssColorToHex('color(srgb 0 0 0 / 0.72)')).toBe('#000000')
  })
})

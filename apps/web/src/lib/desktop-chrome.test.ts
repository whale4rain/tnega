// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
  conversation.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 58)
  drawer.getBoundingClientRect = () => new DOMRect(700, 58, 580, 58)
  markWindowControls(root, 1280)
  expect(conversation.classList.contains('window-controls-header')).toBe(true)
  expect(drawer.classList.contains('window-controls-header')).toBe(false)
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

describe('cssColorToHex', () => {
  it('converts computed colours and skips transparent ones', () => {
    expect(cssColorToHex('rgb(246, 245, 241)')).toBe('#f6f5f1')
    expect(cssColorToHex('rgba(20, 22, 21, 1)')).toBe('#141615')
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeUndefined()
    expect(cssColorToHex(' #1B1E1D')).toBe('#1b1e1d')
    expect(cssColorToHex('transparent')).toBeUndefined()
  })
})

describe('backgroundBehind', () => {
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

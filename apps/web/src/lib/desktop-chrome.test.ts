// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { backgroundBehind, cssColorToHex, markWindowControls } from './desktop-chrome'

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

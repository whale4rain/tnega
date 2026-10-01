// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { backgroundBehind, cssColorToHex } from './desktop-chrome'

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

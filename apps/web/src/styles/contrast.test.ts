import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The palette's accessibility floors (docs/design/tnega-design.md#contrast),
 * checked against tokens.css itself so a colour change cannot quietly break
 * them in either theme.
 */
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

function theme(selector: RegExp): Record<string, string> {
  const block = css.match(selector)?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/giu)].map(match => [match[1]!, match[2]!.toLowerCase()]))
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
  const [r, g, b] = channels.map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const THEMES = {
  light: theme(/:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/u),
  dark: theme(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/u),
}

describe.each(Object.entries(THEMES))('%s palette', (name, t) => {
  const surfaces = ['bg', 'surface', 'surface-raised', 'surface-sunken'] as const

  it('keeps body text at least 7:1 and every text colour at AA (4.5:1) on every surface', () => {
    for (const surface of surfaces) {
      expect(contrast(t.text!, t[surface]!), `text on ${surface}`).toBeGreaterThanOrEqual(7)
      for (const role of ['text-2', 'text-3', 'accent-text', 'success', 'warn', 'danger'] as const) {
        expect(contrast(t[role]!, t[surface]!), `${role} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps editor syntax colours at AA on code and panel surfaces', () => {
    for (const surface of ['code-bg', 'surface', 'surface-raised'] as const) {
      for (const role of ['keyword', 'string', 'number', 'comment', 'function', 'type', 'property'] as const) {
        expect(contrast(t[`syntax-${role}`]!, t[surface]!), `syntax-${role} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps accent fills readable and borders visible', () => {
    expect(contrast(t['text-inverse']!, t.accent!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['text-inverse']!, t.danger!), 'danger button').toBeGreaterThanOrEqual(4.5)
    expect(contrast(t.border!, t.surface!)).toBeGreaterThanOrEqual(1.25)
    expect(contrast(t['border-strong']!, t.surface!)).toBeGreaterThanOrEqual(1.6)
  })

  if (name === 'dark') {
    it('shows elevation as lightness steps: bg < surface < raised', () => {
      expect(contrast(t.surface!, t.bg!)).toBeGreaterThanOrEqual(1.08)
      expect(contrast(t['surface-raised']!, t.bg!)).toBeGreaterThanOrEqual(1.15)
      expect(luminance(t['surface-raised']!)).toBeGreaterThan(luminance(t.surface!))
    })
  }
})

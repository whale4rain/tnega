import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The one floor that cannot be checked from tokens.css alone: glass is translucent, so
 * what is behind a floating shell is part of the reading. The alpha in tokens.css is
 * chosen so that every text role still clears its floor against any surface this app
 * draws behind a popover, which is what this file proves, palette by palette.
 *
 * The decision and its accepted cost (a photo, the browser view or another window
 * behind a popover can push body text to about 6.5:1 in dark mode) are in
 * docs/design/tnega-design.md 3.2.
 */
const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const project = readFileSync(new URL('./project.css', import.meta.url), 'utf8')

/** The colour and number tokens a theme block sets. */
function block(selector: RegExp): Record<string, string> {
  const body = tokens.match(selector)?.[1] ?? ''
  const hex = [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/giu)].map(match => [match[1]!, match[2]!.toLowerCase()])
  const numbers = [...body.matchAll(/--([\w-]+):\s*([\d.]+)\s*;/gu)].map(match => [match[1]!, match[2]!])
  return Object.fromEntries([...hex, ...numbers])
}

const BASE = {
  light: block(/:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/u),
  dark: block(/^\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/mu),
}

const PALETTES = [...new Set([...tokens.matchAll(/\[data-palette="([\w-]+)"\]/gu)].map(match => match[1]!))]

const THEMES: Array<[string, 'light' | 'dark', Record<string, string>]> = [
  ['sky light', 'light', BASE.light],
  ['sky dark', 'dark', BASE.dark],
  ...PALETTES.flatMap(palette => (['light', 'dark'] as const).map(mode => {
    const overrides = block(new RegExp('\\[data-palette="' + palette + '"\\]\\[data-theme="' + mode + '"\\]\\s*\\{([\\s\\S]*?)\\n\\}', 'u'))
    return [palette + ' ' + mode, mode, { ...BASE[mode], ...overrides }] as [string, 'light' | 'dark', Record<string, string>]
  })),
]

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]

function luminance(colour: readonly number[]): number {
  const [r, g, b] = colour.map(value => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** What the eye reads behind text on a glass surface: the surface over its backdrop. */
function overGlass(surface: readonly number[], alpha: number, backdrop: readonly number[]): number[] {
  return surface.map((value, index) => value * alpha + backdrop[index]! * (1 - alpha))
}

describe.each(THEMES)('%s glass', (_label, _mode, theme) => {
  const alpha = Number.parseFloat(theme['glass-alpha']!)

  it('keeps the material visible instead of opaque', () => {
    expect(alpha).toBeGreaterThanOrEqual(0.7)
    expect(alpha).toBeLessThanOrEqual(0.85)
  })

  it('keeps every text role readable over every surface the app draws behind a popover', () => {
    const glass = rgb(theme['surface-raised']!)
    for (const behind of ['bg', 'bg-sidebar', 'surface', 'surface-raised', 'surface-sunken', 'code-bg'] as const) {
      const shown = overGlass(glass, alpha, rgb(theme[behind]!))
      expect(contrast(rgb(theme.text!), shown), 'text over ' + behind).toBeGreaterThanOrEqual(7)
      for (const role of ['text-2', 'text-3', 'accent-text', 'success', 'warn', 'danger'] as const) {
        expect(contrast(rgb(theme[role]!), shown), role + ' over ' + behind).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

/** Every rule that paints the glass surface, with its selector. */
function glassRules(css: string): Array<{ selector: string; body: string }> {
  return [...css.matchAll(/([^\n{}]+)\{([^}]*)\}/gu)]
    .filter(match => (match[2] ?? '').includes('var(--glass-surface)'))
    .map(match => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }))
}

it('defines the material once, in the tokens', () => {
  for (const token of ['--glass-alpha', '--glass-blur', '--glass-saturate', '--glass-surface']) expect(tokens, token).toContain(token)
  // The material is a recipe, not a colour: every palette inherits both alphas.
  for (const mode of ['light', 'dark'] as const) {
    const overrides = PALETTES.map(palette => block(new RegExp('\\[data-palette="' + palette + '"\\]\\[data-theme="' + mode + '"\\]\\s*\\{([\\s\\S]*?)\\n\\}', 'u')))
    for (const blockTokens of overrides) expect(blockTokens['glass-alpha'], 'glass-alpha in ' + mode).toBeUndefined()
  }
})

it('paints glass with the blur on every shell, and falls back when transparency is off', () => {
  const rules = [...glassRules(app), ...glassRules(project)]
  expect(rules.length, 'glass surfaces').toBe(4)
  for (const rule of rules) {
    expect(rule.body, rule.selector).toContain('backdrop-filter: blur(var(--glass-blur))')
    expect(rule.selector.startsWith('.')).toBe(true)
  }
  // The fallback lists every glass shell, so none can be left half glass.
  const fallback = app.match(/@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  for (const rule of rules) for (const part of rule.selector.split(',')) expect(fallback, 'fallback for ' + part).toContain(part.trim())
})

it('keeps surfaces that carry body copy opaque', () => {
  // Glass is for shells that float over the app; the reading surfaces stay solid.
  for (const opaque of ['.conv-scroll', '.sidebar', '.wb-frame', '.dialog', '.composer']) {
    const bodies = [...app.matchAll(/([^\n{}]+)\{([^}]*)\}/gu)]
      .filter(match => (match[1] ?? '').includes(opaque))
      .map(match => match[2] ?? '')
    expect(bodies.some(body => body.includes('var(--glass-surface)')), opaque + ' stays opaque').toBe(false)
  }
})

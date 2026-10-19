import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

/**
 * Pele paints diagrams with `--pele-*` variables on `.mermaid-canvas`; every
 * one of them has to come from a palette token, or a diagram would keep the
 * light palette in dark mode (docs/design/tnega-design.md#3).
 */
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const canvas = css.match(/\.mermaid-canvas \{([\s\S]*?)\n\}/u)?.[1] ?? ''
const declarations = [...canvas.matchAll(/(--pele-[\w-]+):\s*([^;]+);/gu)]
  .map(match => [match[1]!, match[2]!.trim()] as const)

it('maps every pele colour to a palette token', () => {
  const names = new Set(declarations.map(([name]) => name))
  for (const name of ['--pele-bg', '--pele-fg', '--pele-muted', '--pele-line', '--pele-surface', '--pele-surface-alt', '--pele-border', '--pele-accent', '--pele-critical', '--pele-error']) {
    expect(names.has(name), name).toBe(true)
  }
  for (const [name, value] of declarations) {
    if (name === '--pele-font' || name === '--pele-font-mono') {
      expect(value, name).toMatch(/^var\(--font-[\w-]+\)$/u)
      continue
    }
    expect(value, name).toMatch(/^var\(--[\w-]+\)$/u)
  }
})

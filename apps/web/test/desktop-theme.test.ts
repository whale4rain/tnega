import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')

describe('desktop editorial visual system', () => {
  test('uses Claude-inspired parchment tokens and accessible focus states', async () => {
    const styles = await readFile(stylesPath, 'utf8')

    expect(styles).toContain('--canvas: #faf9f6')
    expect(styles).toContain('--ink: #141413')
    expect(styles).toContain('--clay: #a9583c')
    expect(styles).toContain(':focus-visible')
    expect(styles).not.toContain('box-shadow')
    expect(styles).not.toContain('linear-gradient')
  })
})

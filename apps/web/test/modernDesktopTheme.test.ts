import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')

describe('modern desktop theme', () => {
  test('uses rounded elevated surfaces instead of the legacy square controls', async () => {
    const styles = await readFile(stylesPath, 'utf8')

    expect(styles).toContain('--window-surface')
    expect(styles).toContain('border-radius: 12px')
    expect(styles).toContain('border-radius: 10px')
  })
})

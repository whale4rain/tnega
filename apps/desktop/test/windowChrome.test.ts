import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const mainPath = resolve(import.meta.dirname, '../src/main.ts')

describe('desktop window chrome', () => {
  test('removes the native menu and starts the workspace maximized', async () => {
    const main = await readFile(mainPath, 'utf8')

    expect(main).toContain('Menu.setApplicationMenu(null)')
    expect(main).toContain("titleBarStyle: 'hidden'")
    expect(main).toContain('window.maximize()')
  })
})

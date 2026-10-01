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

describe('title bar overlay colours', () => {
  test('follow the renderer theme through a validated IPC call', async () => {
    const main = await readFile(mainPath, 'utf8')
    expect(main).toContain("ipcMain.on('tnega:title-bar-colors'")
    expect(main).toContain('setTitleBarOverlay')
    expect(main).not.toContain("color: '#222222'")
    const { parseTitleBarColors } = await import('../src/titlebar.js')
    expect(parseTitleBarColors({ background: '#F6F5F1', foreground: '#57544d' })).toEqual({ background: '#f6f5f1', foreground: '#57544d' })
    expect(parseTitleBarColors({ background: 'red', foreground: '#000000' })).toBeUndefined()
    expect(parseTitleBarColors({ background: '#000000' })).toBeUndefined()
    expect(parseTitleBarColors('url(javascript:1)')).toBeUndefined()
  })
})

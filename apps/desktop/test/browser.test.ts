import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, ipcMain: {}, WebContentsView: class {} }))

const { parseBrowserRect } = await import('../src/browser.js')

describe('browser view bounds from the renderer', () => {
  test('accepts finite rectangles, rounds them and treats empty ones as hidden', () => {
    expect(parseBrowserRect({ x: 10.4, y: 58.6, width: 640.2, height: 700 })).toEqual({ x: 10, y: 59, width: 640, height: 700 })
    expect(parseBrowserRect(null)).toBeNull()
    expect(parseBrowserRect({ x: 0, y: 0, width: 0, height: 10 })).toBeNull()
  })

  test('ignores anything else', () => {
    expect(parseBrowserRect({ x: 1, y: 2, width: Number.NaN, height: 3 })).toBeUndefined()
    expect(parseBrowserRect('0,0,10,10')).toBeUndefined()
    expect(parseBrowserRect({ x: 1, y: 2 })).toBeUndefined()
  })
})

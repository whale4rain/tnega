import { describe, expect, test } from 'vitest'
import { hasDesktopFolderPicker, pickFolder } from './desktopBridge'

describe('desktop workspace bridge', () => {
  test('returns no picker result when the desktop host is absent', async () => {
    expect(hasDesktopFolderPicker({})).toBe(false)
  })

  test('uses the desktop folder picker when the host provides one', async () => {
    const target = {
      tnegaDesktop: {
        pickFolder: async () => 'C:/workspace',
        revealWorkspace: async () => undefined,
        version: () => '0.4.2',
      },
    }
    expect(hasDesktopFolderPicker(target)).toBe(true)
    await expect(pickFolder(target)).resolves.toBe('C:/workspace')
  })
})

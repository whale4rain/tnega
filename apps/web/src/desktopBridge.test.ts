import { describe, expect, test } from 'vitest'
import { hasDesktopFolderPicker, pickDesktopFolder } from './desktopBridge'

describe('desktop workspace bridge', () => {
  test('returns no picker result when the desktop host is absent', async () => {
    expect(hasDesktopFolderPicker({})).toBe(false)
    await expect(pickDesktopFolder({})).resolves.toBeUndefined()
  })
})

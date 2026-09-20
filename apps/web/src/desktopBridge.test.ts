import { describe, expect, test } from 'vitest'
import { hasDesktopWorkspacePicker, pickDesktopWorkspace } from './desktopBridge'

describe('desktop workspace bridge', () => {
  test('returns no picker result when the desktop host is absent', async () => {
    expect(hasDesktopWorkspacePicker({})).toBe(false)
    await expect(pickDesktopWorkspace({})).resolves.toBeUndefined()
  })
})

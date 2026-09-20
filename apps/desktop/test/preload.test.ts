import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const preloadPath = resolve(import.meta.dirname, '../src/preload.ts')

async function readPreload(): Promise<string> {
  try {
    return await readFile(preloadPath, 'utf8')
  } catch {
    return ''
  }
}

describe('desktop preload bridge', () => {
  test('exposes only workspace and application integration methods', async () => {
    const preload = await readPreload()

    expect(preload).toContain("contextBridge.exposeInMainWorld('tnegaDesktop'")
    expect(preload).toContain('pickWorkspace')
    expect(preload).toContain('revealWorkspace')
    expect(preload).toContain('version')
    expect(preload).not.toContain('nodeIntegration')
  })
})

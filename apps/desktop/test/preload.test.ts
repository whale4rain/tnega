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
    expect(preload).toContain('pickFolder')
    expect(preload).toContain('revealWorkspace')
    expect(preload).toContain('version')
    expect(preload).toContain("ipcRenderer.send('tnega:title-bar-colors'")
    expect(preload).not.toContain('nodeIntegration')
  })
})

describe('desktop browser bridge', () => {
  test('only places, navigates and observes the agent browser view', async () => {
    const preload = await readPreload()

    for (const channel of ['tnega:browser-bounds', 'tnega:browser-navigate', 'tnega:browser-command']) {
      expect(preload).toContain(`ipcRenderer.send('${channel}'`)
    }
    expect(preload).toContain("ipcRenderer.on('tnega:browser-state'")
    expect(preload).toContain("ipcRenderer.on('tnega:browser-reveal'")
    // Listeners are removable, and the renderer never sees the raw IPC event.
    expect(preload).toContain("ipcRenderer.removeListener('tnega:browser-state'")
    expect(preload).toMatch(/\(_event: unknown, state: unknown\) => listener\(state\)/)
  })
})

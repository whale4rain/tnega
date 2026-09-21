import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const configPath = resolve(import.meta.dirname, '../electron-builder.yml')
const buildScriptPath = resolve(import.meta.dirname, '../scripts/build.mjs')
const iconPath = resolve(import.meta.dirname, '../build/icon.ico')

async function readBuilderConfig(): Promise<string> {
  try {
    return await readFile(configPath, 'utf8')
  } catch {
    return ''
  }
}

describe('desktop packaging', () => {
  test('ships compiled application and Tnega runtime resources', async () => {
    const config = await readBuilderConfig()

    expect(config).toContain('out/**')
    expect(config).toContain('extraResources:')
    expect(config).toContain('../../dist')
    expect(config).toContain('tnega-runtime')
  })

  test('uses the Tnega icon for Windows packages', async () => {
    const config = await readBuilderConfig()

    expect(config).toContain('icon: build/icon.ico')
  })

  test('uses square image layers in the Windows icon', async () => {
    const icon = await readFile(iconPath)
    const imageCount = icon.readUInt16LE(4)

    expect(imageCount).toBeGreaterThan(0)
    for (let index = 0; index < imageCount; index += 1) {
      const offset = 6 + index * 16
      const width = icon[offset] || 256
      const height = icon[offset + 1] || 256
      expect(width).toBe(height)
    }
  })

  test('provides CommonJS compatibility to bundled Node dependencies', async () => {
    const buildScript = await readFile(buildScriptPath, 'utf8')

    expect(buildScript).toContain("createRequire as __tnegaCreateRequire")
  })
})

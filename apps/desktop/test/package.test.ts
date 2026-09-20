import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const configPath = resolve(import.meta.dirname, '../electron-builder.yml')

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
})

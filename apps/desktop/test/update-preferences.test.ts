import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readUpdateChannel, saveUpdateChannel } from '../src/update-preferences.js'

test('restores the chosen channel from disk and defaults safely on invalid preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tnega-update-'))
  const file = join(dir, 'preferences.json')
  try {
    expect(readUpdateChannel(file)).toBe('stable')
    saveUpdateChannel(file, 'preview')
    expect(readUpdateChannel(file)).toBe('preview')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ channel: 'preview' })
    saveUpdateChannel(file, 'stable')
    expect(readUpdateChannel(file)).toBe('stable')
    writeFileSync(file, '{broken')
    expect(readUpdateChannel(file)).toBe('stable')
    writeFileSync(file, JSON.stringify({ channel: 'unknown' }))
    expect(readUpdateChannel(file)).toBe('stable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

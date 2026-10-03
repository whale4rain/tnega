import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UpdateChannel } from './updater.js'

export function readUpdateChannel(file: string): UpdateChannel {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && Reflect.get(value, 'channel') === 'preview' ? 'preview' : 'stable'
  } catch { return 'stable' }
}

export function saveUpdateChannel(file: string, channel: UpdateChannel): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify({ channel }) + '\n', 'utf8')
  renameSync(`${file}.tmp`, file)
}

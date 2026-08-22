import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export function stableStringify(value: unknown): string {
  const seen = new Set<unknown>()
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'function' || typeof entry === 'symbol') return undefined
    if (entry && typeof entry === 'object') {
      if (seen.has(entry)) return '[Circular]'
      seen.add(entry)
      if (Array.isArray(entry)) {
        return entry.map(item => item ?? null)
      }
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(entry).sort()) {
        sorted[key] = entry[key]
      }
      return sorted
    }
    return entry
  })
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value) ?? '').digest('hex').slice(0, 16)
}

export function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}

export async function saveJson(file: string, value: unknown): Promise<void> {
  const target = resolve(file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function loadJson<T>(file: string): Promise<T> {
  const text = await readFile(resolve(file), 'utf8')
  return JSON.parse(text) as T
}

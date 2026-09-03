import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadManifest, saveManifest } from '../src/manifest.js'
import type { BenchmarkManifest } from '../src/types.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function manifest(source: 'bigcodebench' | 'swebench', ids: string[]): BenchmarkManifest {
  return {
    source,
    version: source === 'bigcodebench' ? 'v0.1.4' : 'verified',
    importedAt: 1,
    total: ids.length,
    tasks: ids.map(id => ({
      id,
      fixtureDir: `fixtures/${id}`,
      taskFile: 'tasks.json',
      dataset: source,
    })),
  }
}

describe('manifest merge', () => {
  it('keeps tasks from both sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-manifest-'))
    dirs.push(dir)
    await saveManifest(dir, manifest('bigcodebench', ['BigCodeBench/0', 'BigCodeBench/1']))
    await saveManifest(dir, manifest('swebench', ['sympy__sympy-23950']))

    const saved = await loadManifest(join(dir, 'manifest.json'))
    expect(saved.total).toBe(3)
    expect(saved.sources).toEqual({
      bigcodebench: { version: 'v0.1.4', total: 2 },
      swebench: { version: 'verified', total: 1 },
    })
    expect(saved.tasks.map(task => task.id)).toEqual([
      'BigCodeBench/0',
      'BigCodeBench/1',
      'sympy__sympy-23950',
    ])
  })

  it('replaces tasks of the same source on re-import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-manifest-replace-'))
    dirs.push(dir)
    await saveManifest(dir, manifest('bigcodebench', ['BigCodeBench/0']))
    await saveManifest(dir, manifest('bigcodebench', ['BigCodeBench/2']))

    const saved = await loadManifest(join(dir, 'manifest.json'))
    expect(saved.total).toBe(1)
    expect(saved.tasks.map(task => task.id)).toEqual(['BigCodeBench/2'])
  })
})

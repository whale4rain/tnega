import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { MemoryError } from '@tnega/memory'
import { memoryLocal } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('keeps global and project memory in separate files and deduplicates explicit saves', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-memory-'))
  directories.push(cwd)
  const globalFile = join(cwd, 'home', 'MEMORY.md')
  const root = new Context()
  try {
    await root.plugin(memoryLocal, { cwd, globalFile })
    const memory = root.memory
    expect(await memory.read('global')).toBe('')
    expect(await memory.read('project')).toBe('')
    await memory.rememberGlobal('Prefers concise answers')
    await memory.rememberGlobal('Prefers concise answers')
    await memory.writeProject('# Project memory\n\n- Use pnpm')
    expect(await memory.read('global')).toContain('- Prefers concise answers')
    expect((await readFile(globalFile, 'utf8')).match(/Prefers concise answers/g)).toHaveLength(1)
    expect(await readFile(join(cwd, '.tnega', 'MEMORY.md'), 'utf8')).toContain('- Use pnpm')
  } finally {
    await root.fiber.dispose()
  }
})

it('rejects oversized project memory without replacing the previous version', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-memory-'))
  directories.push(cwd)
  const root = new Context()
  try {
    await root.plugin(memoryLocal, { cwd, globalFile: join(cwd, 'global.md') })
    await root.memory.writeProject('- Keep this')
    expect(() => root.memory.writeProject('x'.repeat(4_001)))
      .toThrowError(new MemoryError('project memory exceeds its 4000 character limit', 'MEMORY_FULL'))
    expect(await root.memory.read('project')).toBe('- Keep this\n')
  } finally {
    await root.fiber.dispose()
  }
})

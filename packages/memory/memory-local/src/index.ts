import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@tnega/core'
import {
  MAX_GLOBAL_MEMORY_CHARS,
  MAX_PROJECT_MEMORY_CHARS,
  MemoryError,
  MemoryService,
  type MemoryScope,
} from '@tnega/memory'

export interface LocalMemoryConfig {
  cwd?: string
  /** Defaults to ~/.tnega/MEMORY.md. Useful for isolated installations and tests. */
  globalFile?: string
}

const writes = new Map<string, Promise<void>>()

async function exclusive<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>(resolve => { release = resolve })
  writes.set(path, current)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (writes.get(path) === current) writes.delete(path)
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new MemoryError(`could not read memory file ${path}`, 'MEMORY_FAILED', { cause: error })
  }
}

async function migrateLegacyFile(path: string): Promise<void> {
  if (path !== join(dirname(path), 'MEMORY.md')) return
  const directory = dirname(path)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new MemoryError(`could not inspect memory directory ${directory}`, 'MEMORY_FAILED', { cause: error })
  }
  if (names.includes('MEMORY.md') || !names.includes('memory.md')) return
  const legacy = join(directory, 'memory.md')
  const temp = join(directory, `.memory-${randomUUID()}.tmp`)
  try {
    await rename(legacy, temp)
    try {
      await rename(temp, path)
    } catch (error) {
      await rename(temp, legacy).catch(() => {})
      throw error
    }
  } catch (error) {
    throw new MemoryError(`could not migrate memory file ${legacy}`, 'MEMORY_FAILED', { cause: error })
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw new MemoryError(`could not write memory file ${path}`, 'MEMORY_FAILED', { cause: error })
  }
}

export class LocalMemoryService extends MemoryService {
  private readonly globalFile: string
  private readonly projectFile: string

  constructor(ctx: Context, config: LocalMemoryConfig = {}) {
    super(ctx)
    this.globalFile = resolve(config.globalFile ?? join(homedir(), '.tnega', 'MEMORY.md'))
    this.projectFile = resolve(config.cwd ?? process.cwd(), '.tnega', 'MEMORY.md')
  }

  override read(scope: MemoryScope): Promise<string> {
    if (scope !== 'global' && scope !== 'project') {
      throw new MemoryError(`invalid memory scope: ${String(scope)}`, 'MEMORY_INVALID')
    }
    const path = scope === 'global' ? this.globalFile : this.projectFile
    return exclusive(path, async () => {
      await migrateLegacyFile(path)
      return readText(path)
    })
  }

  override rememberGlobal(content: string): Promise<string> {
    const entry = content.trim()
    if (!entry || /[\r\n]/.test(entry)) {
      throw new MemoryError('global memory must be one non-empty line', 'MEMORY_INVALID')
    }
    return exclusive(this.globalFile, async () => {
      await migrateLegacyFile(this.globalFile)
      const current = (await readText(this.globalFile)).trim()
      const line = `- ${entry.replace(/^-\s*/, '')}`
      if (current.split('\n').some(existing => existing.trim() === line)) return current
      const next = current ? `${current}\n${line}\n` : `# User preferences\n\n${line}\n`
      if (next.length > MAX_GLOBAL_MEMORY_CHARS) {
        throw new MemoryError('global memory is full; edit ~/.tnega/MEMORY.md before adding more', 'MEMORY_FULL')
      }
      await writeAtomic(this.globalFile, next)
      return next
    })
  }

  override writeProject(content: string): Promise<void> {
    const next = content.trim()
    if (next.length > MAX_PROJECT_MEMORY_CHARS) {
      throw new MemoryError('project memory exceeds its 4000 character limit', 'MEMORY_FULL')
    }
    return exclusive(this.projectFile, async () => {
      await migrateLegacyFile(this.projectFile)
      if ((await readText(this.projectFile)).trim() === next) return
      await writeAtomic(this.projectFile, next ? `${next}\n` : '')
    })
  }
}

export const memoryLocal = {
  name: 'memory-local',
  apply(ctx: Context, config: LocalMemoryConfig = {}): void {
    new LocalMemoryService(ctx, config)
  },
}

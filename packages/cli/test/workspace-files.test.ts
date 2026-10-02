import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FileServeError } from '../src/files.js'
import { listDirectory, readTextFile, writeTextFile } from '../src/workspace-files.js'

const dirs: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-files-'))
  dirs.push(dir)
  await mkdir(join(dir, 'src', 'lib'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, 'README.md'), '# hi\n')
  await writeFile(join(dir, 'src', 'index.ts'), 'export const a = 1\n')
  await writeFile(join(dir, 'src', 'file10.ts'), '')
  await writeFile(join(dir, 'src', 'file9.ts'), '')
  await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function status(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof FileServeError) return error.status
    throw error
  }
}

describe('workspace files panel', () => {
  it('lists one directory at a time, folders first, without VCS and dependency trees', async () => {
    const dir = await workspace()
    expect((await listDirectory(dir)).map(entry => `${entry.type}:${entry.path}`)).toEqual([
      'dir:src', 'file:logo.png', 'file:README.md',
    ])
    expect((await listDirectory(dir, 'src')).map(entry => entry.name)).toEqual(['lib', 'file9.ts', 'file10.ts', 'index.ts'])
  })

  it('opens text, declines binary files, and refuses paths outside the workspace', async () => {
    const dir = await workspace()
    expect(await readTextFile(dir, 'src/index.ts')).toMatchObject({ path: 'src/index.ts', content: 'export const a = 1\n' })
    const binary = await readTextFile(dir, 'logo.png')
    expect(binary.reason).toBe('binary')
    expect(binary.content).toBeUndefined()
    expect(await status(readTextFile(dir, '../outside.txt'))).toBe(400)
    expect(await status(listDirectory(dir, '../..'))).toBe(400)
    expect(await status(readTextFile(dir, 'missing.ts'))).toBe(404)
  })

  it('refuses to follow a symlink out of the workspace', async () => {
    const dir = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'tnega-outside-'))
    dirs.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    try {
      await symlink(outside, join(dir, 'escape'), 'junction')
    } catch {
      return // Creating links can need privileges on Windows.
    }
    expect(await status(readTextFile(dir, 'escape/secret.txt'))).toBe(400)
  })

  it('saves edits, and refuses a save over a newer change on disk', async () => {
    const dir = await workspace()
    const opened = await readTextFile(dir, 'README.md')
    const saved = await writeTextFile(dir, 'README.md', '# edited\n', opened.mtimeMs)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# edited\n')
    expect(saved.mtimeMs).toBe((await stat(join(dir, 'README.md'))).mtimeMs)

    // Someone else (the agent) writes after the editor loaded `saved`.
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
    await writeFile(join(dir, 'README.md'), '# agent\n')
    expect(await status(writeTextFile(dir, 'README.md', '# mine\n', saved.mtimeMs))).toBe(409)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# agent\n')
  })
})

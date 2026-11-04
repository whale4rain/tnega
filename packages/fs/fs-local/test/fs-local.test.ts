import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { FsError } from '@tnega/fs'
import { LocalWorkspaceFs, fsLocal } from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
})

/** Symlinks need a privilege on Windows; skip those cases where it is missing. */
async function trySymlink(target: string, path: string, type?: 'dir' | 'file'): Promise<boolean> {
  try {
    await symlink(target, path, type)
    return true
  } catch {
    return false
  }
}

describe('ctx.fs local provider', () => {
  it('opens a workspace from ctx.fs and refuses a second provider in one scope', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const root = new Context()
    await root.plugin(fsLocal)
    const fs = root.get('fs').workspace(dir)
    await fs.writeFile('a/b.txt', 'hello')
    expect(Buffer.from(await fs.readFile('a/b.txt')).toString('utf8')).toBe('hello')
    await expect(root.plugin(fsLocal)).rejects.toThrow()
  })

  it('reads a byte range and reports stat for files, directories and missing paths', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const fs = new LocalWorkspaceFs(dir)
    await writeFile(join(dir, 'digits.txt'), '0123456789')
    expect(Buffer.from(await fs.readFile('digits.txt', { start: 2, end: 5 })).toString()).toBe('234')
    expect(Buffer.from(await fs.readFile('digits.txt', { start: 8, end: 20 })).toString()).toBe('89')
    expect(await fs.stat('digits.txt')).toMatchObject({ kind: 'file', size: 10 })
    expect(await fs.stat('.')).toMatchObject({ kind: 'dir' })
    expect(await fs.stat('missing.txt')).toBeUndefined()
    expect(await fs.stat('digits.txt/below')).toBeUndefined()
  })

  it('replaces atomically, keeps permission bits and leaves no staging behind', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const fs = new LocalWorkspaceFs(dir)
    await writeFile(join(dir, 'run.sh'), 'echo old\n')
    await chmod(join(dir, 'run.sh'), 0o755)
    await fs.writeFile('run.sh', 'echo new\n')
    expect(await readFile(join(dir, 'run.sh'), 'utf8')).toBe('echo new\n')
    if (process.platform !== 'win32') expect((await stat(join(dir, 'run.sh'))).mode & 0o777).toBe(0o755)
    expect(await readdir(dir)).toEqual(['run.sh'])
  })

  it('appends, creating the file and its folders when missing', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const fs = new LocalWorkspaceFs(dir)
    await fs.writeFile('logs/run.log', 'one\n', { mode: 'append' })
    await fs.writeFile('logs/run.log', Buffer.from('two\n'), { mode: 'append' })
    expect(await readFile(join(dir, 'logs', 'run.log'), 'utf8')).toBe('one\ntwo\n')
  })

  it('refuses a create over an existing file with FS_EXISTS', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const fs = new LocalWorkspaceFs(dir)
    await fs.writeFile('note.md', 'first', { mode: 'create' })
    const error = await fs.writeFile('note.md', 'second', { mode: 'create' }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_EXISTS')
    expect(await readFile(join(dir, 'note.md'), 'utf8')).toBe('first')
  })

  it('fences every call: parent paths and absolute names outside are refused', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const outside = await tempDir('tnega-fs-outside-')
    await writeFile(join(outside, 'secret.txt'), 'no')
    const fs = new LocalWorkspaceFs(dir)
    await expect(fs.readFile('../secret.txt')).rejects.toThrow(/escapes/)
    await expect(fs.readFile(join(outside, 'secret.txt'))).rejects.toThrow(/escapes/)
    await expect(fs.writeFile(join(outside, 'new.txt'), 'x')).rejects.toThrow(/escapes/)
    await expect(fs.list(outside)).rejects.toThrow(/escapes/)
    await expect(fs.remove(join(outside, 'secret.txt'))).rejects.toThrow(/escapes/)
    await expect(fs.rename(join(outside, 'secret.txt'), 'here.txt')).rejects.toThrow(/escapes/)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('no')
  })

  it('refuses a symlink that leads out, and writes through one that stays inside', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const outside = await tempDir('tnega-fs-outside-')
    await writeFile(join(outside, 'secret.txt'), 'no')
    await writeFile(join(dir, 'real.txt'), 'old')
    const fs = new LocalWorkspaceFs(dir)
    if (!await trySymlink(outside, join(dir, 'escape'), 'dir')) return
    await expect(fs.readFile('escape/secret.txt')).rejects.toThrow(/escapes/)
    await expect(fs.writeFile('escape/secret.txt', 'pwned')).rejects.toThrow(/escapes/)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('no')

    if (!await trySymlink('real.txt', join(dir, 'link.txt'), 'file')) return
    expect(await fs.resolve('link.txt')).toBe(await realpath(join(dir, 'real.txt')))
    await fs.writeFile('link.txt', 'new')
    expect(await readFile(join(dir, 'real.txt'), 'utf8')).toBe('new')
  })

  it('lets paths leave the workspace only with allowOutside, read per call', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const outside = await tempDir('tnega-fs-outside-')
    await writeFile(join(outside, 'shared.txt'), 'yes')
    let bypass = false
    const fs = new LocalWorkspaceFs(dir, { allowOutside: () => bypass })
    await expect(fs.readFile(join(outside, 'shared.txt'))).rejects.toThrow(/escapes/)
    bypass = true
    expect(Buffer.from(await fs.readFile(join(outside, 'shared.txt'))).toString()).toBe('yes')
  })

  it('takes platform-native and forward-slash relative paths alike', async () => {
    const dir = await tempDir('tnega-fs-local-')
    const fs = new LocalWorkspaceFs(dir)
    await fs.mkdir(join('a', 'b'))
    await fs.writeFile('a/b/c.txt', 'x')
    expect(await fs.stat(join('a', 'b', 'c.txt'))).toMatchObject({ kind: 'file', size: 1 })
    expect((await fs.list(join('a', 'b'))).map(entry => entry.name)).toEqual(['c.txt'])
    await fs.rename('a/b/c.txt', join('a', 'd.txt'))
    expect(await fs.stat('a/d.txt')).toMatchObject({ kind: 'file' })
    await fs.remove('a', { recursive: true })
    expect(await fs.stat('a')).toBeUndefined()
  })

  it('lists entries with their own kind, symlinks included', async () => {
    const dir = await tempDir('tnega-fs-local-')
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'file.txt'), 'x')
    const fs = new LocalWorkspaceFs(dir)
    const linked = await trySymlink('file.txt', join(dir, 'link.txt'), 'file')
    const kinds = Object.fromEntries((await fs.list('')).map(entry => [entry.name, entry.kind]))
    expect(kinds).toMatchObject({ sub: 'dir', 'file.txt': 'file', ...linked ? { 'link.txt': 'symlink' } : {} })
  })
})

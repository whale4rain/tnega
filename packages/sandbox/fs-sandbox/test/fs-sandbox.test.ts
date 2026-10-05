import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PathSandboxError,
  assertWritablePath,
  canonicalPath,
  isWritablePath,
  resolveInside,
  writableRoots,
} from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('resolveInside', () => {
  it('accepts a relative path inside the workspace, including one that does not exist yet', async () => {
    const root = await tempDir('tnega-fs-inside-')
    await mkdir(join(root, 'src'), { recursive: true })
    expect(await resolveInside(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'))
    expect(await resolveInside(root, '.')).toBe(root)
  })

  it('rejects an empty path and an inaccessible workspace root', async () => {
    await expect(resolveInside(tmpdir(), '  '))
      .rejects.toMatchObject({ name: 'PathSandboxError', code: 'FS_PATH_INVALID' })
    await expect(resolveInside(join(tmpdir(), 'tnega-fs-missing-root'), 'a'))
      .rejects.toMatchObject({ code: 'FS_PATH_INVALID' })
  })

  it('rejects traversal and absolute paths outside the workspace', async () => {
    const root = await tempDir('tnega-fs-escape-')
    await expect(resolveInside(root, '../outside.txt'))
      .rejects.toMatchObject({ code: 'FS_PATH_ESCAPES_WORKSPACE' })
    await expect(resolveInside(root, join(tmpdir(), 'outside.txt')))
      .rejects.toMatchObject({ code: 'FS_PATH_ESCAPES_WORKSPACE' })
  })

  it('rejects a path that leaves the workspace through a symlinked parent', async () => {
    const root = await tempDir('tnega-fs-symlink-')
    const outside = await tempDir('tnega-fs-outside-')
    await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(resolveInside(root, 'link/planted.txt'))
      .rejects.toThrowError(/escapes the workspace through a symlink/)
  })

  it('does not exist as a second implementation: the tools re-export is this one', async () => {
    const root = await tempDir('tnega-fs-single-')
    const error = await resolveInside(root, '../x').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(PathSandboxError)
  })
})

describe('writable paths', () => {
  it('denies every write in read-only mode', async () => {
    const root = await tempDir('tnega-fs-readonly-')
    const policy = { mode: 'read-only', workspaceRoot: root } as const
    expect(isWritablePath(join(root, 'a.txt'), policy)).toBe(false)
    expect(() => assertWritablePath(join(root, 'a.txt'), policy))
      .toThrowError(/file access denied under read-only mode/)
  })

  it('confines workspace-write to the writable roots', async () => {
    const root = await tempDir('tnega-fs-write-')
    const temp = await tempDir('tnega-fs-temp-')
    const policy = { mode: 'workspace-write', workspaceRoot: root, tempRoot: temp } as const
    expect(isWritablePath(join(root, 'a.txt'), policy)).toBe(true)
    expect(isWritablePath(join(temp, 'a.txt'), policy)).toBe(true)
    expect(isWritablePath(join(root, '..', 'a.txt'), policy)).toBe(false)
    expect(writableRoots(policy)).toContain(canonicalPath(temp))
    expect(() => assertWritablePath(join(root, '..', 'a.txt'), policy))
      .toThrowError(/file access denied under workspace-write mode/)
  })

  it('lets a write through a symlinked parent escape be denied by identity', async () => {
    const root = await tempDir('tnega-fs-write-link-')
    const temp = await tempDir('tnega-fs-write-tmp-')
    const outside = await tempDir('tnega-fs-write-out-')
    await writeFile(join(outside, 'existing.txt'), 'x', 'utf8')
    await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    // 显式 tempRoot 让可写根只有 root 与 temp —— 否则 tmpdir() 本身就是一个可写根，
    // 「工作区之外」的目录只要建在 tmpdir 下就仍然可写，这个用例就失去意义。
    const policy = { mode: 'workspace-write', workspaceRoot: root, tempRoot: temp } as const
    expect(writableRoots(policy)).toEqual([canonicalPath(root), canonicalPath(temp)])

    // 词法上在 root 之内，真身在 root 之外：必须判否。
    expect(isWritablePath(join(root, 'link', 'existing.txt'), policy)).toBe(false)
  })

  it('treats bypass as "no sandbox" instead of a policy to enforce', async () => {
    const root = await tempDir('tnega-fs-bypass-')
    const policy = { mode: 'bypass', workspaceRoot: root } as const
    expect(isWritablePath(join(root, '..', 'a.txt'), policy)).toBe(true)
  })
})

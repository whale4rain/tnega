import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { containsDirectory, isLexicallyUnder, isPathUnder } from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('isPathUnder', () => {
  it('treats the root itself and its descendants as inside', async () => {
    const root = await tempDir('tnega-fs-under-')
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    expect(isPathUnder(root, root)).toBe(true)
    expect(isPathUnder(join(root, 'a'), root)).toBe(true)
    expect(isPathUnder(join(root, 'a', 'b'), root)).toBe(true)
    expect(isPathUnder(join(root, '..'), root)).toBe(false)
  })

  it('does not treat a sibling with a shared prefix as inside', async () => {
    const parent = await tempDir('tnega-fs-prefix-')
    const root = join(parent, 'work')
    const sibling = join(parent, 'work-other')
    await mkdir(root, { recursive: true })
    await mkdir(sibling, { recursive: true })
    expect(isPathUnder(join(sibling, 'file.txt'), root)).toBe(false)
  })

  it('falls back to filesystem identity when the spelling differs', async () => {
    const root = await tempDir('tnega-fs-identity-')
    const real = join(root, 'real')
    const alias = join(root, 'alias')
    await mkdir(real, { recursive: true })
    // junction 在 Windows 上不需要管理员权限，是这里唯一可用的目录别名。
    await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')

    expect(isLexicallyUnder(join(alias, 'file.txt'), real)).toBe(false)
    expect(isPathUnder(join(alias, 'file.txt'), real)).toBe(true)
  })

  it('does not throw when the root cannot be stat\u2019ed and the path is not lexically under it', () => {
    const missing = join(tmpdir(), 'tnega-fs-sandbox-definitely-missing')
    const elsewhere = join(tmpdir(), 'tnega-fs-sandbox-elsewhere')
    expect(isPathUnder(join(elsewhere, 'file.txt'), missing)).toBe(false)
  })

  it('answers lexically for a path that runs through a regular file segment', async () => {
    const root = await tempDir('tnega-fs-blocker-')
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    // 词法包含是纯字符串性质，与文件系统形态无关；真正打开时由内核以 ENOTDIR 拒绝。
    // 身份回退那一路才需要处理 ENOTDIR（它会继续向上找祖先）。
    expect(isPathUnder(join(blocker, 'child.txt'), root)).toBe(true)
    expect(isPathUnder(join(blocker, 'child.txt'), join(root, 'blocker', 'nested'))).toBe(false)
  })

  it('compares case-insensitively on Windows only', () => {
    const upper = 'C:\\Work\\File.txt'
    const lower = 'c:\\work'
    expect(isLexicallyUnder(upper, lower, false)).toBe(true)
    expect(isLexicallyUnder(upper, lower, true)).toBe(false)
  })
})

describe('containsDirectory', () => {
  it('accepts the root itself and rejects escaping relatives', () => {
    const root = process.platform === 'win32' ? 'C:\\work' : '/work'
    expect(containsDirectory(root, root)).toBe(true)
    expect(containsDirectory(root, join(root, 'a'))).toBe(true)
    expect(containsDirectory(root, join(root, '..'))).toBe(false)
  })
})

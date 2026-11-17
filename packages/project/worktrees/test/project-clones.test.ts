import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { discardThreadWorktrees, prepareThreadClone, threadBranch, threadCloneDir, threadCloneOwner, threadClonesRoot } from '../src/index.js'

const exec = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })
  return stdout.trim()
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tnega-clones-'))
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  await git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'README.md'), 'hello\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-q', '-m', 'base')
  await git(root, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  return root
}

it('gives a thread its own clone at the folder\'s HEAD, pushing where the folder does, without uncommitted files', async () => {
  const root = await repo()
  await writeFile(join(root, 'draft.txt'), 'not committed\n')
  const clone = await prepareThreadClone(root, 't1')
  expect(clone).toBe(threadCloneDir(root, 't1'))
  expect(threadCloneOwner(clone ?? '')).toBe(root)
  expect(threadCloneOwner(root)).toBeUndefined()
  expect(existsSync(join(clone ?? '', 'README.md'))).toBe(true)
  expect(existsSync(join(clone ?? '', 'draft.txt'))).toBe(false)
  expect(await git(clone ?? '', 'remote', 'get-url', 'origin')).toBe('https://github.com/o/r.git')
  expect(await git(clone ?? '', 'rev-parse', 'HEAD')).toBe(await git(root, 'rev-parse', 'HEAD'))
  // Asked again, the same clone; a different thread, a different one.
  await writeFile(join(clone ?? '', 'mine.txt'), 'thread work\n')
  expect(await prepareThreadClone(root, 't1')).toBe(clone)
  expect(existsSync(join(clone ?? '', 'mine.txt'))).toBe(true)
  const other = await prepareThreadClone(root, 't2')
  expect(existsSync(join(other ?? '', 'mine.txt'))).toBe(false)
})

it('mounts a folder outside git as it is', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'tnega-clones-plain-'))
  cleanups.push(() => rm(plain, { recursive: true, force: true }))
  expect(await prepareThreadClone(plain, 't1')).toBeUndefined()
})

it('brings a deleted thread\'s unpushed work back to the folder before removing its clone', async () => {
  const root = await repo()
  const branch = (id: string) => threadBranch('p1', id)
  const clone = await prepareThreadClone(root, 'busy') ?? ''
  await git(clone, 'checkout', '-q', '-b', branch('busy'))
  await git(clone, 'commit', '-q', '--allow-empty', '-m', 'thread work')
  await prepareThreadClone(root, 'idle')
  const result = await discardThreadWorktrees({ root, threadIds: ['busy', 'idle'], checkoutRoots: [], branch, clones: threadClonesRoot(root) })
  expect(existsSync(clone)).toBe(false)
  expect(existsSync(threadCloneDir(root, 'idle'))).toBe(false)
  expect(result.kept).toEqual([branch('busy')])
  expect(await git(root, 'log', '-1', '--format=%s', branch('busy'))).toBe('thread work')
})

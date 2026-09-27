/**
 * runner argv 前缀解析：显式覆盖最优先，否则按「发布形态 → 仓库内 dev 形态」的顺序，在
 * **本模块同目录**里找 runner。
 *
 * 发布形态那一步用注入的假模块 URL 覆盖：临时目录里放一个 `sandbox-windows-acl-runner.js`
 * 就等价于构建产物布局，不需要真的构建。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { resolveRunnerCommand } from '../src/index.js'

/** 本包的源码 runner（测试运行时一定存在）。 */
const sourceRunner = fileURLToPath(new URL('../src/runner.ts', import.meta.url))

const scratchDirs: string[] = []

/** 造一个假的「模块所在目录」，并可选地放入发布/dev 形态的 runner 文件。 */
function fakeModuleDir(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tnega-acl-runner-cmd-'))
  scratchDirs.push(dir)
  for (const file of files) writeFileSync(join(dir, file), '// fixture\n')
  return dir
}

/** 指向假目录里 `index.js` 的模块 URL。 */
function anchorIn(dir: string): URL {
  return pathToFileURL(join(dir, 'index.js'))
}

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveRunnerCommand', () => {
  it('uses an explicit runnerCommand verbatim (as a copy)', () => {
    const override = ['C:\\tools\\fake-runner.exe', '--flag']
    const resolved = resolveRunnerCommand({ runnerCommand: override })
    expect(resolved).toEqual(override)
    expect(resolved).not.toBe(override)
  })

  it('rejects an empty override instead of silently falling back', () => {
    expect(() => resolveRunnerCommand({ runnerCommand: [] })).toThrow(/must not be empty/u)
  })

  it('resolves the published runner entry when it sits next to the module', () => {
    // 发布形态：dist/sandbox-windows-acl.js 与 dist/sandbox-windows-acl-runner.js 同目录。
    const dir = fakeModuleDir(['sandbox-windows-acl-runner.js', 'runner.ts'])
    expect(resolveRunnerCommand({ moduleUrl: anchorIn(dir) })).toEqual([
      process.execPath,
      join(dir, 'sandbox-windows-acl-runner.js'),
    ])
  })

  it('falls back to the module-adjacent source runner when there is no published bundle', () => {
    const dir = fakeModuleDir(['runner.ts'])
    expect(resolveRunnerCommand({ moduleUrl: anchorIn(dir) })).toEqual([
      process.execPath,
      join(dir, 'runner.ts'),
    ])
  })

  it('resolves the real in-repo dev form (this checkout) under node', () => {
    const resolved = resolveRunnerCommand()
    expect(resolved).toEqual([process.execPath, sourceRunner])
  })

  it('throws with both tried paths when the anchor directory carries no runner', () => {
    const dir = fakeModuleDir([])
    expect(() => resolveRunnerCommand({ moduleUrl: anchorIn(dir) })).toThrow(/sandbox-windows-acl-runner\.js/u)
    expect(() => resolveRunnerCommand({ moduleUrl: anchorIn(dir) })).toThrow(/runner\.ts/u)
    expect(() => resolveRunnerCommand({ moduleUrl: anchorIn(dir) })).toThrow(/runnerCommand/u)
  })
})

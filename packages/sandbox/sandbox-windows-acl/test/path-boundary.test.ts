/**
 * 目录边界：私有 temp 与 workspace 的重叠检查（双向）。
 *
 * 检查基于 `realpathSync.native`，所以用例里的目录都先按规范拼写建好再断言。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { assertPrivateTempDisjoint, assertTempRootOutsideWorkspace } from '../src/index.js'

const scratchRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'tnega-acl-boundary-')))
const workspace = join(scratchRoot, 'workspace')
const nestedTemp = join(workspace, 'temp')
const siblingTemp = join(scratchRoot, 'temp')
mkdirSync(nestedTemp, { recursive: true })
mkdirSync(siblingTemp, { recursive: true })

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
})

describe('assertTempRootOutsideWorkspace', () => {
  it('rejects a temp root inside the workspace, or the workspace itself', () => {
    expect(() => assertTempRootOutsideWorkspace(workspace, nestedTemp)).toThrow(/outside the workspace/u)
    expect(() => assertTempRootOutsideWorkspace(workspace, workspace)).toThrow(/outside the workspace/u)
    expect(() => assertTempRootOutsideWorkspace(workspace, join(workspace, '..', 'workspace'))).toThrow(/outside the workspace/u)
  })

  it('accepts a sibling temp root', () => {
    expect(() => assertTempRootOutsideWorkspace(workspace, siblingTemp)).not.toThrow()
    expect(() => assertTempRootOutsideWorkspace(siblingTemp, workspace)).not.toThrow()
  })
})

describe('assertPrivateTempDisjoint', () => {
  it('rejects overlap in both containment directions and equality', () => {
    // temp 在 workspace 内、workspace 在 temp 内、两者相等：都会合并两个能力的边界。
    expect(() => assertPrivateTempDisjoint(nestedTemp, [workspace])).toThrow(/disjoint/u)
    expect(() => assertPrivateTempDisjoint(workspace, [nestedTemp])).toThrow(/disjoint/u)
    expect(() => assertPrivateTempDisjoint(workspace, [workspace])).toThrow(/disjoint/u)
  })

  it('accepts disjoint siblings, and reports the offending pair', () => {
    expect(() => assertPrivateTempDisjoint(siblingTemp, [workspace])).not.toThrow()
    expect(() => assertPrivateTempDisjoint(workspace, [siblingTemp])).not.toThrow()
    expect(() => assertPrivateTempDisjoint(nestedTemp, [workspace])).toThrow(/writable=.*workspace/u)
  })
})

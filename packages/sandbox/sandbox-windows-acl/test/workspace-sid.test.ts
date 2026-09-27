/**
 * 写 SID 派生：确定性、形状、workspace/temp 的域分离、规范化拼写收敛，
 * 以及 runner 内部那份实现与包导出的实现逐位一致（runner 不能相对 import，
 * 因此算法在两处各有一份拷贝，这个断言就是钉住它们的那颗钉子）。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { tempWriteSid, workspaceWriteSid } from '../src/index.js'
import { deriveTempWriteSid, deriveWorkspaceWriteSid } from '../src/runner.js'

const scratchRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'tnega-acl-sid-')))

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
})

function scratch(name: string): string {
  const dir = join(scratchRoot, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** SDDL 形态检查，并把两个子授权号解析出来。 */
function parseWorkspaceSid(sid: string): { first: number; second: number; parts: string[] } {
  const match = /^S-1-4-(\d+)-(\d+)$/u.exec(sid)
  expect(match, `unexpected SID shape: ${sid}`).not.toBeNull()
  const parts = (match?.[0] ?? '').split('-')
  return { first: Number(match?.[1]), second: Number(match?.[2]), parts }
}

describe('workspace/temp write SID derivation', () => {
  it('is deterministic and stays in the S-1-4-<30bit>-<30bit> shape', () => {
    const workspace = scratch('deterministic')
    const first = workspaceWriteSid(workspace)
    const second = workspaceWriteSid(workspace)
    expect(second).toBe(first)

    const parsed = parseWorkspaceSid(first)
    expect(parsed.first).toBeGreaterThanOrEqual(1)
    expect(parsed.first).toBeLessThanOrEqual(2 ** 30 - 1)
    expect(parsed.second).toBeGreaterThanOrEqual(1)
    expect(parsed.second).toBeLessThanOrEqual(2 ** 30 - 1)
    expect(parsed.parts).toHaveLength(5)
  })

  it('separates workspace and temp identities for the same directory', () => {
    const dir = scratch('separation')
    const workspaceSid = workspaceWriteSid(dir)
    const tempSid = tempWriteSid(dir)
    expect(tempSid).not.toBe(workspaceSid)
    // 第三个子授权号把 temp 身份与所有两段式 workspace 身份在域上分开。
    expect(tempSid.startsWith(`${workspaceSid}-`)).toBe(false)
    expect(/^S-1-4-\d+-\d+-1$/u.test(tempSid)).toBe(true)
  })

  it('gives different directories different identities', () => {
    expect(workspaceWriteSid(scratch('one'))).not.toBe(workspaceWriteSid(scratch('two')))
    expect(tempWriteSid(scratch('one'))).not.toBe(tempWriteSid(scratch('two')))
  })

  it('converges on one identity for every canonical spelling of one directory', () => {
    const dir = scratch('spellings')
    const dotted = `${scratchRoot}${sep}.${sep}spellings`
    const trailing = `${dir}${sep}`
    const upper = dir.toUpperCase()
    const canonical = workspaceWriteSid(dir)
    expect(workspaceWriteSid(realpathSync.native(dotted))).toBe(canonical)
    expect(workspaceWriteSid(realpathSync.native(trailing))).toBe(canonical)
    expect(workspaceWriteSid(realpathSync.native(upper))).toBe(canonical)
  })

  it('matches the runner-local derivation bit for bit', () => {
    const workspace = scratch('parity-workspace')
    const temp = scratch('parity-temp')
    expect(deriveWorkspaceWriteSid(workspace)).toBe(workspaceWriteSid(workspace))
    expect(deriveTempWriteSid(temp)).toBe(tempWriteSid(temp))
    expect(deriveWorkspaceWriteSid(workspace)).not.toBe(deriveTempWriteSid(workspace))
  })
})

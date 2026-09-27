/**
 * 真实的 ACL 生命周期（Windows-only，需要 koffi）：用 icacls（运维自己会用的工具）看
 * 结果，并用本包自己的绑定把目录 DACL 读回来逐字段断言。
 *
 * 这里的断言不依赖任何进程内 spawn：它验证的正是 Provider 会走的路径——
 * 授予 → 幂等重授予 → 撤销 → 清理，以及「常驻 workspace / 可撤销 temp」的生命周期差异。
 *
 * 所有状态都在 %TEMP% 的 mkdtemp 目录里，测试自己清理。唯一的例外是每路径锁所在的
 * `<GetTempPathW()>\tnega-acl-locks`：它是跨实例共享的基础设施，删除会与并行测试打架，
 * 因此留着（只多一个几字节的锁文件）。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { lockFilePath, withPathLock } from '../src/acl.js'
import { isWindowsAclAvailable, win32 } from '../src/ffi.js'
import type { NativePtr, Win32Api } from '../src/ffi.js'
import { AclWriteGrant, tempWriteSid, workspaceWriteSid } from '../src/index.js'
import * as abi from '../src/win32-abi.js'
import { readAces } from './support/acl-reader.js'

const aclReady = process.platform === 'win32' && await isWindowsAclAvailable()
const scratchDirs: string[] = []

function scratch(name: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `tnega-acl-${name}-`)))
  scratchDirs.push(dir)
  return dir
}

/** icacls 渲染出来的目录 DACL（运维可见形态）。 */
function icaclsText(path: string): string {
  const result = spawnSync('icacls', [path], { encoding: 'utf8' })
  expect(result.status, `icacls failed: ${result.stderr}`).toBe(0)
  return result.stdout
}

/** 本用例读回目录的显式 ACE（继承而来的不算）：共享助手。 */
function readDirectAces(api: Win32Api, path: string): Array<{ sid: string; mask: number; flags: number }> {
  return readAces(api, path)
}

describe.skipIf(!aclReady)('ACL lifecycle against the real directory DACL', () => {
  let api: Win32Api

  beforeAll(async () => {
    api = await win32()
  })

  afterAll(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('grants the capability SID (visible to icacls), stays idempotent, and revokes cleanly', async () => {
    const dir = scratch('lifecycle')
    const sid = workspaceWriteSid(dir)
    const grant = await AclWriteGrant.create(sid)
    try {
      await grant.add(dir, { revocable: true })
      expect(icaclsText(dir)).toContain(sid)
      const first = readDirectAces(api, dir).filter(ace => ace.sid === sid)
      expect(first).toHaveLength(1)
      expect(first[0]?.mask).toBe(abi.GRANT_MASK)
      expect(first[0]?.flags).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT)

      // 二次授予命中「完全一致 ACE」：只读一次 DACL，不重复写、不重复 ACE。
      await grant.add(dir, { revocable: true })
      expect(readDirectAces(api, dir).filter(ace => ace.sid === sid)).toHaveLength(1)
      expect(icaclsText(dir).split(sid)).toHaveLength(2)

      await grant.revoke(dir)
      expect(readDirectAces(api, dir).some(ace => ace.sid === sid)).toBe(false)
      expect(icaclsText(dir)).not.toContain(sid)
    } finally {
      await grant.dispose()
    }
  })

  it('carries DELETE and FILE_DELETE_CHILD but never WRITE_DAC / WRITE_OWNER', async () => {
    const dir = scratch('mask')
    const sid = workspaceWriteSid(dir)
    const grant = await AclWriteGrant.create(sid)
    try {
      await grant.add(dir, { revocable: true })
      const ace = readDirectAces(api, dir).find(candidate => candidate.sid === sid)
      expect(ace).toBeDefined()
      const mask = ace?.mask ?? 0
      expect(mask).toBe(abi.GRANT_MASK)
      expect(mask & abi.DELETE).toBe(abi.DELETE)
      expect(mask & abi.FILE_DELETE_CHILD).toBe(abi.FILE_DELETE_CHILD)
      expect(mask & abi.WRITE_DAC).toBe(0)
      expect(mask & abi.WRITE_OWNER).toBe(0)
      // icacls 至少要把这条 SID 渲染出来（掩码不是标准名字组合，可能显示为组件列表）。
      expect(icaclsText(dir)).toContain(sid)
    } finally {
      await grant.dispose()
    }
  })

  it('dispose revokes the revocable temp ACE and keeps the standing workspace ACE', async () => {
    const workspaceDir = scratch('standing-workspace')
    const tempDir = scratch('standing-temp')
    const workspaceSid = workspaceWriteSid(workspaceDir)
    const privateTempSid = tempWriteSid(tempDir)

    const workspaceGrant = await AclWriteGrant.create(workspaceSid)
    await workspaceGrant.add(workspaceDir) // 常驻：dispose 不撤销
    const tempGrant = await AclWriteGrant.create(privateTempSid)
    await tempGrant.add(tempDir, { revocable: true })

    expect(workspaceGrant.paths).toEqual([workspaceDir])
    expect(tempGrant.paths).toEqual([tempDir])

    await tempGrant.dispose()
    await workspaceGrant.dispose()

    expect(readDirectAces(api, workspaceDir).some(ace => ace.sid === workspaceSid)).toBe(true)
    expect(icaclsText(workspaceDir)).toContain(workspaceSid)
    expect(readDirectAces(api, tempDir).some(ace => ace.sid === privateTempSid)).toBe(false)
    expect(icaclsText(tempDir)).not.toContain(privateTempSid)
  })

  it('merges into the current DACL instead of replacing it', async () => {
    const dir = scratch('merge')
    // mkdtemp 目录自带的 ACE 全是继承来的，因此先落一条别人的显式 ACE，
    // 再验证我们的授予是「合并」而不是「替换」。
    const foreignSid = 'S-1-4-424242-1'
    const foreignGrant = await AclWriteGrant.create(foreignSid)
    await foreignGrant.add(dir, { revocable: true })
    const before = readDirectAces(api, dir)
    expect(before.some(ace => ace.sid === foreignSid)).toBe(true)

    const sid = workspaceWriteSid(dir)
    const grant = await AclWriteGrant.create(sid)
    try {
      await grant.add(dir, { revocable: true })
      const after = readDirectAces(api, dir)
      expect(after.some(ace => ace.sid === foreignSid)).toBe(true)
      expect(after.some(ace => ace.sid === sid)).toBe(true)

      // REVOKE_ACCESS 只删该受托者的 ACE，别人的显式 ACE 原样保留。
      await grant.revoke(dir)
      const revoked = readDirectAces(api, dir)
      expect(revoked.some(ace => ace.sid === sid)).toBe(false)
      expect(revoked.some(ace => ace.sid === foreignSid)).toBe(true)
    } finally {
      await grant.dispose()
      await foreignGrant.dispose()
    }
  })

  it('serializes through the per-path lock and releases it when the action throws', async () => {
    const dir = scratch('lock')
    const lockPath = lockFilePath(api, dir)
    mkdirSync(dirname(lockPath), { recursive: true })

    const open = (): NativePtr => api.createFileW(
      lockPath, abi.GENERIC_READ | abi.GENERIC_WRITE,
      abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE, null, abi.OPEN_ALWAYS, 0, null,
    )
    // withPathLock 的 action 抛错也必须解锁。
    expect(() => withPathLock(api, dir, () => {
      throw new Error('action failure')
    })).toThrow('action failure')

    const first = open()
    const second = open()
    try {
      expect(api.lockFileEx(first, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, api.allocOverlapped())).toBe(1)
      expect(api.lockFileEx(
        second,
        abi.LOCKFILE_EXCLUSIVE_LOCK | abi.LOCKFILE_FAIL_IMMEDIATELY,
        0, 1, 0, api.allocOverlapped(),
      )).toBe(0)
      expect(api.getLastError()).toBe(abi.ERROR_LOCK_VIOLATION)
      expect(api.unlockFileEx(first, 0, 1, 0, api.allocOverlapped())).toBe(1)
    } finally {
      api.closeHandle(first)
      api.closeHandle(second)
      rmSync(lockPath, { force: true })
    }
  })
})

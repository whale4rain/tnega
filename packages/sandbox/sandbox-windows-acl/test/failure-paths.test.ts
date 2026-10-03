/**
 * 失败路径：用假绑定表驱动**每一条**被检查的 Win32 调用，断言失败都带 API 名与精确错误码。
 *
 * 这些用例是跨平台的，也不需要 koffi —— 生产代码里 koffi 只在真实实现内部出现，所以
 * 「每个失败分支都必须抛出」这条契约在任何宿主上都能被验证。
 *
 * 同时也用同一张假表验证两件不该依赖 Windows 的逻辑：
 * - 完全一致的 ACE 已在位时**跳过** SetNamedSecurityInfoW（幂等，避免全树重传播）；
 * - 写 ACE 的掩码与继承标志（含 DELETE / FILE_DELETE_CHILD，不含 WRITE_DAC / WRITE_OWNER）。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { buildExplicitAccess, grantWrite, revokeWrite } from '../src/acl.js'
import { __setWin32BindingsForTest } from '../src/ffi.js'
import type { NativePtr, Win32Api } from '../src/ffi.js'
import { AclWriteGrant } from '../src/index.js'
import {
  RunnerUsageError,
  createRestrictedSandboxToken,
  findLogonSid,
  openCurrentProcessToken,
  spawnRestrictedInherited,
  waitForRestrictedExit,
} from '../src/runner.js'
import * as abi from '../src/win32-abi.js'
import { createFakeWin32, encodeSid } from './support/fake-win32.js'
import type { FakeBindings } from './support/fake-win32.js'

afterEach(() => {
  __setWin32BindingsForTest(undefined)
})

/** 造一段只有一个 ACCESS_ALLOWED_ACE 的 ACL（8 字节头 + ACE）。 */
function grantAclBytes(sid: string, mask: number = abi.GRANT_MASK): Buffer {
  const sidBytes = encodeSid(sid)
  const aceSize = abi.ACE_INLINE_SID_OFFSET + sidBytes.length // header(4) + mask(4) + inline SID
  const bytes = Buffer.alloc(abi.ACL_HEADER_SIZE + aceSize)
  bytes.writeUInt8(2, 0) // AclRevision
  bytes.writeUInt16LE(bytes.length, 2) // AclSize
  bytes.writeUInt16LE(1, 4) // AceCount
  bytes.writeUInt8(abi.ACCESS_ALLOWED_ACE_TYPE, abi.ACL_HEADER_SIZE)
  bytes.writeUInt8(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.ACL_HEADER_SIZE + 1)
  bytes.writeUInt16LE(aceSize, abi.ACL_HEADER_SIZE + 2) // AceSize
  bytes.writeUInt32LE(mask, abi.ACL_HEADER_SIZE + abi.ACE_MASK_OFFSET)
  sidBytes.copy(bytes, abi.ACL_HEADER_SIZE + abi.ACE_INLINE_SID_OFFSET)
  return bytes
}

/** 覆盖 getNamedSecurityInfoW，让它报告一段「已经存在」的显式 DACL。 */
function withExistingDacl(
  fake: ReturnType<typeof createFakeWin32>,
  acl: NativePtr,
): FakeBindings {
  const descriptor = fake.allocBytesAt(Buffer.alloc(8))
  return {
    ...fake.bindings,
    getNamedSecurityInfoW: (_path, _objectType, _information, owner, group, dacl, sacl, descriptorSlot) => {
      fake.record('getNamedSecurityInfoW')
      fake.setPtr(owner, null)
      fake.setPtr(group, null)
      fake.setPtr(dacl, acl)
      fake.setPtr(sacl, null)
      fake.setPtr(descriptorSlot, descriptor)
      return 0
    },
  }
}

describe('the packed grant entry', () => {
  it('carries GRANT_MASK with OI|CI inheritance', () => {
    const fake = createFakeWin32()
    const sid: NativePtr = fake.allocBytesAt(encodeSid('S-1-4-1234-5'))
    const entry = buildExplicitAccess(fake.bindings, sid, abi.GRANT_ACCESS, abi.GRANT_MASK)

    expect(entry).toHaveLength(abi.EXPLICIT_ACCESS_W_SIZE)
    expect(entry.readUInt32LE(0)).toBe(abi.GRANT_MASK)
    expect(entry.readUInt32LE(4)).toBe(abi.GRANT_ACCESS)
    expect(entry.readUInt32LE(8)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT)
    expect(entry.readUInt32LE(abi.TRUSTEE_W_OFFSET + 12)).toBe(abi.TRUSTEE_IS_SID)
    expect(entry.readBigUInt64LE(abi.TRUSTEE_W_OFFSET + abi.TRUSTEE_W_PTSTRNAME_OFFSET)).toBe(sid)
  })

  it('grants write + delete but never WRITE_DAC / WRITE_OWNER', () => {
    expect(abi.GRANT_MASK & abi.DELETE).toBe(abi.DELETE)
    expect(abi.GRANT_MASK & abi.FILE_DELETE_CHILD).toBe(abi.FILE_DELETE_CHILD)
    expect(abi.GRANT_MASK & abi.WRITE_DAC).toBe(0)
    expect(abi.GRANT_MASK & abi.WRITE_OWNER).toBe(0)
    expect(abi.GRANT_MASK & abi.STANDARD_RIGHTS_WRITE).toBe(0)
    // FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES
    expect(abi.GRANT_MASK & 0x00000116).toBe(0x00000116)
  })
})

describe('AclWriteGrant.create failure paths', () => {
  it('reports ConvertStringSidToSidW with the exact Win32 code for a malformed SID', async () => {
    const fake = createFakeWin32({
      convertStringSidToSidW: () => 0,
      getLastError: () => 1337,
    })
    __setWin32BindingsForTest(fake.bindings)
    await expect(AclWriteGrant.create('S-1-4-not-a-sid')).rejects.toMatchObject({
      name: 'Win32Error',
      api: 'ConvertStringSidToSidW',
      win32Code: 1337,
    })
  })

  it('reports ConvertStringSidToSidW when it succeeds but returns a null SID', async () => {
    const fake = createFakeWin32()
    __setWin32BindingsForTest({
      ...fake.bindings,
      convertStringSidToSidW: (_sid, sidSlot) => {
        fake.setPtr(sidSlot, null)
        return 1
      },
    })
    await expect(AclWriteGrant.create('S-1-4-1-1')).rejects.toThrow(/ConvertStringSidToSidW/u)
  })
})

describe('grantWrite/revokeWrite failure paths', () => {
  it('reports GetTempPathW when the lock root cannot be resolved', () => {
    const fake = createFakeWin32({ getTempPathW: () => 0, getLastError: () => 1234 })
    expect(() => grantWrite(fake.bindings, 'C:\\fake', 1n)).toThrow(/GetTempPathW failed \(Win32 1234\)/u)
  })

  it('reports an invalid CreateFileW handle without touching the lock', () => {
    const fake = createFakeWin32({ createFileW: () => 0n })
    expect(() => grantWrite(fake.bindings, 'C:\\fake', 1n)).toThrow(/CreateFileW failed/u)
    expect(fake.calls).not.toContain('lockFileEx')
  })

  it('reports LockFileEx (with the exact code) and closes the lock handle', () => {
    const fake = createFakeWin32({
      lockFileEx: () => 0,
      getLastError: () => abi.ERROR_LOCK_VIOLATION,
    })
    expect(() => grantWrite(fake.bindings, 'C:\\fake', 1n)).toThrow(/LockFileEx failed \(Win32 33\)/u)
    expect(fake.calls).toContain('closeHandle')
  })

  it('reports GetNamedSecurityInfoW when the DACL cannot be read', () => {
    const fake = createFakeWin32({ getNamedSecurityInfoW: () => 5 })
    expect(() => grantWrite(fake.bindings, 'C:\\fake', 1n)).toThrow(/GetNamedSecurityInfoW failed \(Win32 5\)/u)
  })

  it('reports SetEntriesInAclW when the merge fails', () => {
    const fake = createFakeWin32({ setEntriesInAclW: () => 87 })
    expect(() => grantWrite(fake.bindings, 'C:\\fake', 1n)).toThrow(/SetEntriesInAclW failed \(Win32 87\)/u)
    expect(fake.calls).not.toContain('setNamedSecurityInfoW')
  })

  it('reports SetNamedSecurityInfoW with the affected path when the apply fails', () => {
    const fake = createFakeWin32({ setNamedSecurityInfoW: () => 1307 })
    expect(() => grantWrite(fake.bindings, 'C:\\fake\\dir', 1n))
      .toThrow(/SetNamedSecurityInfoW failed \(Win32 1307\): grantWrite\(C:\\fake\\dir\)/u)
  })

  it('reports UnlockFileEx and CloseHandle after a successful action', () => {
    const unlockFailure = createFakeWin32({ unlockFileEx: () => 0, getLastError: () => 33 })
    expect(() => grantWrite(unlockFailure.bindings, 'C:\\fake', 1n)).toThrow(/UnlockFileEx failed \(Win32 33\)/u)

    const closeFailure = createFakeWin32({ closeHandle: () => 0, getLastError: () => 6 })
    expect(() => grantWrite(closeFailure.bindings, 'C:\\fake', 1n)).toThrow(/CloseHandle failed \(Win32 6\)/u)
  })

  it('reports SetEntriesInAclW for revoke too, and skips the apply when there is no DACL', () => {
    const failing = createFakeWin32({ setEntriesInAclW: () => 87 })
    const withDacl = withExistingDacl(failing, failing.allocBytesAt(grantAclBytes('S-1-5-32-545', 0x0001)))
    expect(() => revokeWrite(withDacl, 'C:\\fake', 1n)).toThrow(/SetEntriesInAclW failed \(Win32 87\)/u)

    // 默认假表报告「目录没有显式 DACL」：撤销是一次无害的空操作。
    const empty = createFakeWin32()
    expect(revokeWrite(empty.bindings, 'C:\\fake', 1n)).toBe(false)
    expect(empty.calls).not.toContain('setEntriesInAclW')
  })

  it('skips SetNamedSecurityInfoW when the exact grant ACE is already in place', () => {
    const sid = 'S-1-4-7777-5'
    const fake = createFakeWin32()
    const bindings = withExistingDacl(fake, fake.allocBytesAt(grantAclBytes(sid)))
    const sidSlot = bindings.allocPtrSlot()
    expect(bindings.convertStringSidToSidW(sid, sidSlot)).toBe(1)
    const sidPtr = bindings.decodePtr(sidSlot)
    if (sidPtr === null) throw new Error('unreachable: the fake always returns a SID')

    grantWrite(bindings, 'C:\\fake', sidPtr)
    expect(fake.calls).toContain('getNamedSecurityInfoW')
    expect(fake.calls).not.toContain('setEntriesInAclW')
    expect(fake.calls).not.toContain('setNamedSecurityInfoW')
    expect(fake.calls).toContain('localFree') // 描述符被释放
  })

  it('falls back to the merge when the ACL header is implausible', () => {
    const fake = createFakeWin32()
    const malformed = Buffer.alloc(24)
    malformed.writeUInt16LE(4, 2) // AclSize 小于最小的 ACL 头：不可信
    const bindings = withExistingDacl(fake, fake.allocBytesAt(malformed))
    grantWrite(bindings, 'C:\\fake', fake.allocBytesAt(encodeSid('S-1-4-8888-5')))
    expect(fake.calls).toContain('setEntriesInAclW')
    expect(fake.calls).toContain('setNamedSecurityInfoW')
  })
})

describe('AclWriteGrant lifecycle through the fake bindings', () => {
  it('records revocable and standing paths, revokes only the revocable ones and frees the SID', async () => {
    const fake = createFakeWin32()
    // 一个无关的显式 ACE：让每次授予/撤销都真的走「读-合并-写」。
    const bindings = withExistingDacl(fake, fake.allocBytesAt(grantAclBytes('S-1-5-32-545', 0x0001)))
    __setWin32BindingsForTest(bindings)

    const grant = await AclWriteGrant.create('S-1-4-4242-7')
    await grant.add('C:\\temp\\private', { revocable: true })
    await grant.add('C:\\workspace')
    expect(grant.paths).toEqual(['C:\\workspace', 'C:\\temp\\private'])
    expect(fake.calls.filter(name => name === 'setEntriesInAclW')).toHaveLength(2)

    await grant.revoke('C:\\workspace')
    expect(grant.paths).toEqual(['C:\\temp\\private'])
    expect(fake.calls.filter(name => name === 'setEntriesInAclW')).toHaveLength(3)

    await grant.dispose()
    // dispose 只撤销可撤销路径（temp）：第四次合并。
    expect(fake.calls.filter(name => name === 'setEntriesInAclW')).toHaveLength(4)
    expect(fake.calls).toContain('localFree') // SID 被释放
    await expect(grant.add('C:\\late')).rejects.toThrow(/already disposed/u)
    const freesAfterFirstDispose = fake.calls.filter(name => name === 'localFree').length
    await grant.dispose() // 幂等：不再撤销、不再释放
    expect(fake.calls.filter(name => name === 'localFree')).toHaveLength(freesAfterFirstDispose)
  })

  it('aggregates cleanup failures instead of losing them', async () => {
    const fake = createFakeWin32()
    let failReads = false
    const defaultRead: Win32Api['getNamedSecurityInfoW'] = fake.bindings.getNamedSecurityInfoW
    const bindings: FakeBindings = {
      ...fake.bindings,
      getNamedSecurityInfoW: (...args: Parameters<Win32Api['getNamedSecurityInfoW']>) => (failReads ? 5 : defaultRead(...args)),
    }
    __setWin32BindingsForTest(bindings)
    const grant = await AclWriteGrant.create('S-1-4-4242-8')
    await grant.add('C:\\temp\\private', { revocable: true })
    failReads = true
    await expect(grant.dispose()).rejects.toThrow(AggregateError)
    // 失败被汇报之后仍然释放了 SID。
    expect(fake.calls).toContain('localFree')
  })
})

describe('token failure paths', () => {
  it('reports OpenProcess and OpenProcessToken', () => {
    const openFailure = createFakeWin32({ openProcess: () => 0n, getLastError: () => 5 })
    expect(() => openCurrentProcessToken(openFailure.bindings)).toThrow(/OpenProcess failed \(Win32 5\)/u)

    const tokenFailure = createFakeWin32({ openProcessToken: () => 0, getLastError: () => 6 })
    expect(() => openCurrentProcessToken(tokenFailure.bindings)).toThrow(/OpenProcessToken failed \(Win32 6\)/u)
    expect(tokenFailure.calls).toContain('closeHandle') // 进程句柄被尽力关闭
  })

  it('reports a failing TokenGroups size query', () => {
    const fake = createFakeWin32()
    const bindings: FakeBindings = {
      ...fake.bindings,
      getTokenInformation: (_token, _infoClass, info, _length, neededSlot) => {
        if (info !== null) throw new Error('unreachable: the size query must come first')
        fake.setUint32(neededSlot, 0)
        return 0
      },
    }
    expect(() => findLogonSid(bindings, 1n)).toThrow(/GetTokenInformation failed/u)
  })

  it('reports a missing logon SID', () => {
    const fake = createFakeWin32()
    const bindings: FakeBindings = {
      ...fake.bindings,
      getTokenInformation: (_token, _infoClass, info, _length, neededSlot) => {
        fake.setUint32(neededSlot, 8 + 16)
        if (info === null) return 0
        info.writeUInt32LE(1, 0) // 一个组，但没有任何 SE_GROUP_LOGON_ID
        info.writeBigUInt64LE(fake.allocBytesAt(encodeSid('S-1-5-32-545')), 8)
        info.writeUInt32LE(0, 16)
        return 1
      },
    }
    expect(() => findLogonSid(bindings, 1n)).toThrow(/no logon SID found/u)
  })

  it('refuses a workspace-write restricting list without a write SID', () => {
    const fake = createFakeWin32()
    expect(() => createRestrictedSandboxToken(fake.bindings, {
      mode: 'workspace-write',
      writeSid: undefined,
      tempWriteSid: undefined,
    })).toThrow(RunnerUsageError)
    expect(() => createRestrictedSandboxToken(fake.bindings, {
      mode: 'workspace-write',
      writeSid: undefined,
      tempWriteSid: undefined,
    })).toThrow(/requires at least one write SID/u)
  })

  it('reports an unparsable capability SID', () => {
    const fake = createFakeWin32({ convertStringSidToSidW: () => 0, getLastError: () => 1337 })
    expect(() => createRestrictedSandboxToken(fake.bindings, {
      mode: 'workspace-write',
      writeSid: 'S-1-4-not-a-sid',
      tempWriteSid: 'S-1-4-1-1-1',
    })).toThrow(/ConvertStringSidToSidW failed \(Win32 1337\)/u)
  })

  it('reports CreateRestrictedToken and SetEntriesInAclW for the default DACL', () => {
    const createFailure = createFakeWin32({ createRestrictedToken: () => 0, getLastError: () => 87 })
    expect(() => createRestrictedSandboxToken(createFailure.bindings, {
      mode: 'read-only', writeSid: undefined, tempWriteSid: undefined,
    })).toThrow(/CreateRestrictedToken failed \(Win32 87\)/u)

    const daclFailure = createFakeWin32({ setEntriesInAclW: () => 1300 })
    expect(() => createRestrictedSandboxToken(daclFailure.bindings, {
      mode: 'read-only', writeSid: undefined, tempWriteSid: undefined,
    })).toThrow(/SetEntriesInAclW failed \(Win32 1300\): default DACL merge/u)
  })

  it('reports a token without a default DACL', () => {
    const fake = createFakeWin32()
    const bindings: FakeBindings = {
      ...fake.bindings,
      getTokenInformation: (_token, infoClass, info, _length, neededSlot) => {
        const required = infoClass === 6 ? 8 : 8 + 16
        fake.setUint32(neededSlot, required)
        if (info === null) return 0
        if (infoClass === 6) {
          info.writeBigUInt64LE(0n, 0) // 默认 DACL 指针为空
          return 1
        }
        info.writeUInt32LE(1, 0)
        info.writeBigUInt64LE(fake.allocBytesAt(encodeSid('S-1-5-5-0-1')), 8)
        info.writeUInt32LE(abi.SE_GROUP_LOGON_ID, 16)
        return 1
      },
    }
    expect(() => createRestrictedSandboxToken(bindings, {
      mode: 'read-only', writeSid: undefined, tempWriteSid: undefined,
    })).toThrow(/no default DACL to extend/u)
  })

  it('builds a restricting list of logon SID + Everyone under read-only', () => {
    const fake = createFakeWin32()
    const packed: Buffer[] = []
    const bindings: FakeBindings = {
      ...fake.bindings,
      createRestrictedToken: (_existing, flags, _a, _b, _c, _d, restrictCount, sids, tokenSlot) => {
        expect(flags).toBe(abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED)
        expect(restrictCount).toBe(2)
        packed.push(Buffer.from(sids))
        fake.setPtr(tokenSlot, 0x400n)
        return 1
      },
    }
    const token = createRestrictedSandboxToken(bindings, {
      mode: 'read-only', writeSid: undefined, tempWriteSid: undefined,
    })
    expect(token).toBe(0x400n)
    expect(packed).toHaveLength(1)
    const sids = packed[0]
    if (sids === undefined) throw new Error('unreachable: the restricting list was recorded')
    expect(sids).toHaveLength(2 * abi.SID_AND_ATTRIBUTES_SIZE)
    expect(sids.readBigUInt64LE(0)).not.toBe(0n) // logon SID
    expect(sids.readBigUInt64LE(abi.SID_AND_ATTRIBUTES_SIZE)).not.toBe(0n) // Everyone
  })

  it('adds both capability SIDs to the restricting list under workspace-write', () => {
    const fake = createFakeWin32()
    let restrictCount = 0
    const bindings: FakeBindings = {
      ...fake.bindings,
      createRestrictedToken: (_existing, _flags, _a, _b, _c, _d, count, _sids, tokenSlot) => {
        restrictCount = count
        fake.setPtr(tokenSlot, 0x400n)
        return 1
      },
    }
    createRestrictedSandboxToken(bindings, {
      mode: 'workspace-write', writeSid: 'S-1-4-11-22', tempWriteSid: 'S-1-4-11-22-1',
    })
    expect(restrictCount).toBe(4) // logon SID + Everyone + workspace + temp
  })
})

describe('spawn failure paths', () => {
  it('takes the standard handles from the runner and marks them inheritable', () => {
    const fake = createFakeWin32()
    let startupInfo: NativePtr | undefined
    const bindings: FakeBindings = {
      ...fake.bindings,
      createProcessAsUserW: (
        _token,
        _applicationName,
        commandLine,
        _processAttributes,
        _threadAttributes,
        inheritHandles,
        creationFlags,
        _environment,
        currentDirectory,
        startup,
        processInfo,
      ) => {
        expect(inheritHandles).toBe(1)
        expect(creationFlags).toBe(abi.CREATE_SUSPENDED | abi.CREATE_NO_WINDOW)
        expect(commandLine).toBe('cmd /c "echo ok"')
        expect(currentDirectory).toBe('C:\\cwd')
        startupInfo = startup
        const bytes = fake.bytesAt(processInfo)
        bytes.writeBigUInt64LE(0x500n, 0)
        bytes.writeBigUInt64LE(0x600n, 8)
        bytes.writeUInt32LE(4242, 16)
        bytes.writeUInt32LE(4243, 20)
        return 1
      },
    }
    const child = spawnRestrictedInherited(bindings, 0x400n, {
      command: 'cmd',
      args: ['/c', 'echo ok'],
      cwd: 'C:\\cwd',
    })
    expect(child.pid).toBe(4242)
    expect(child.process).toBe(0x500n)
    expect(child.job).toBe(0x800n)
    expect(startupInfo).toBeDefined()
    if (startupInfo === undefined) throw new Error('unreachable: createProcessAsUserW ran')
    const fields = fake.startupInfoAt(startupInfo)
    expect(fields.dwFlags).toBe(abi.STARTF_USESTDHANDLES)
    expect(fields.cb).toBe(abi.STARTUPINFOW_SIZE)
    expect([fields.hStdInput, fields.hStdOutput, fields.hStdError]).toEqual([0x10n, 0x11n, 0x12n])
    expect(fake.calls).toContain('assignProcessToJobObject')
    expect(fake.calls).toContain('resumeThread')
    // 继承位用完立刻还原。
    expect(fake.calls.filter(name => name === 'setHandleInformation')).toHaveLength(6)
  })

  it('reports CreateJobObjectW and SetInformationJobObject', () => {
    const jobFailure = createFakeWin32({ createJobObjectW: () => 0n, getLastError: () => 5 })
    expect(() => spawnRestrictedInherited(jobFailure.bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/CreateJobObjectW failed \(Win32 5\)/u)

    const limitFailure = createFakeWin32({ setInformationJobObject: () => 0, getLastError: () => 87 })
    expect(() => spawnRestrictedInherited(limitFailure.bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/SetInformationJobObject failed \(Win32 87\)/u)
    expect(limitFailure.calls).toContain('closeHandle')
  })

  it('reports GetStdHandle when a standard handle is missing', () => {
    const fake = createFakeWin32({ getStdHandle: () => 0n, getLastError: () => 6 })
    expect(() => spawnRestrictedInherited(fake.bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/GetStdHandle failed \(Win32 6\)/u)
    expect(fake.calls).toContain('closeHandle') // Job 句柄被关掉
  })

  it('reports SetHandleInformation when the inherit bit cannot be set', () => {
    const fake = createFakeWin32({ setHandleInformation: () => 0, getLastError: () => 6 })
    expect(() => spawnRestrictedInherited(fake.bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/SetHandleInformation failed \(Win32 6\)/u)
  })

  it('reports CreateProcessAsUserW, AssignProcessToJobObject and ResumeThread', () => {
    const createFailure = createFakeWin32({ createProcessAsUserW: () => 0, getLastError: () => 740 })
    expect(() => spawnRestrictedInherited(createFailure.bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/CreateProcessAsUserW failed \(Win32 740\)/u)

    const assignFailure = createFakeWin32({ assignProcessToJobObject: () => 0, getLastError: () => 5 })
    expect(() => spawnRestrictedInherited(assignFailure.bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/AssignProcessToJobObject failed \(Win32 5\)/u)
    expect(assignFailure.calls).toContain('terminateProcess') // 挂起的子进程被杀掉

    const resumeFailure = createFakeWin32({ resumeThread: () => 0xffffffff, getLastError: () => 6 })
    expect(() => spawnRestrictedInherited(resumeFailure.bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/ResumeThread failed \(Win32 6\)/u)
    expect(resumeFailure.calls).toContain('terminateProcess')
  })

  it('reports a successful create that returns null handles', () => {
    const fake = createFakeWin32()
    const bindings: FakeBindings = {
      ...fake.bindings,
      createProcessAsUserW: (_token, _app, _cmd, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, processInfo) => {
        const bytes = fake.bytesAt(processInfo)
        bytes.writeBigUInt64LE(0n, 0)
        bytes.writeBigUInt64LE(0n, 8)
        return 1
      },
    }
    expect(() => spawnRestrictedInherited(bindings, 0x400n, { command: 'cmd', args: [], cwd: 'C:\\' }))
      .toThrow(/null process\/thread handles/u)
  })
})

describe('waitForRestrictedExit', () => {
  it('returns the exit code and closes both handles', () => {
    const fake = createFakeWin32()
    expect(waitForRestrictedExit(fake.bindings, { pid: 4242, process: 0x500n, job: 0x800n })).toBe(7)
    expect(fake.calls.filter(name => name === 'closeHandle')).toHaveLength(2)
  })

  it('reports WaitForSingleObject and GetExitCodeProcess failures', () => {
    const waitFailure = createFakeWin32({ waitForSingleObject: () => 0xffffffff, getLastError: () => 6 })
    expect(() => waitForRestrictedExit(waitFailure.bindings, { pid: 1, process: 1n, job: 2n }))
      .toThrow(/WaitForSingleObject failed \(Win32 6\)/u)

    const exitFailure = createFakeWin32({ getExitCodeProcess: () => 0, getLastError: () => 6 })
    expect(() => waitForRestrictedExit(exitFailure.bindings, { pid: 1, process: 1n, job: 2n }))
      .toThrow(/GetExitCodeProcess failed \(Win32 6\)/u)
  })

  it('keeps a full-width exit code intact (uint32, no truncation)', () => {
    const fake = createFakeWin32()
    const bindings: FakeBindings = {
      ...fake.bindings,
      getExitCodeProcess: (_process, exitCodeSlot) => {
        fake.setUint32(exitCodeSlot, 3221225477) // 0xC0000005
        return 1
      },
    }
    expect(waitForRestrictedExit(bindings, { pid: 1, process: 1n, job: 2n })).toBe(3221225477)
  })
})

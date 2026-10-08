/**
 * 测试用的假 Win32 绑定表。
 *
 * 目的：让每一条 API 失败分支都能在**任何平台**、**没有安装 koffi** 的宿主上断言，而生产
 * 代码不必为了可测性放宽任何错误处理。假表同时满足 `src/ffi.ts` 的 `Win32Api` 与
 * `src/runner.ts` 的 `RunnerBindings`（两边的公共成员签名必须逐字一致，否则这里的交叉
 * 类型会直接编译失败）。
 *
 * 内存模型：每个「地址」是一张小记录（指针槽 / uint32 槽 / 字节块），`alloc*` 分配地址，
 * `decode*` 读。SID 字节按 Windows 的真实布局（revision@0、count@1、authority@2 六字节
 * 大端、subAuthority@8）编码，因此 `sameSidAt` 这类按偏移比较的逻辑也能被真实驱动。
 */

import { tmpdir } from 'node:os'

import type { NativePtr, Win32Api } from '../../src/ffi.js'
import type { ProcessInfoFields, RunnerBindings, StartupInfoFields } from '../../src/runner.js'

/** 假表：两边接口的交集（用来钉住共享成员的签名）。 */
export type FakeBindings = Win32Api & RunnerBindings

/** STARTUPINFOW 的字段偏移（x64）。 */
const STARTUPINFO_FLAGS_OFFSET = 60
const STARTUPINFO_STDIN_OFFSET = 80
/** PROCESS_INFORMATION 的字段偏移（x64）。 */
const PROCESS_INFO_STRUCT_SIZE = 24
/** SE_GROUP_LOGON_ID：logon session SID 的属性位。 */
const SE_GROUP_LOGON_ID = 0xc0000000
/** TokenGroups 结构：GroupCount@0，SID_AND_ATTRIBUTES[]@8（16 字节跨度）。 */
const TOKEN_GROUPS_ENTRY_OFFSET = 8

interface FakeSlot {
  ptr: NativePtr | null
  u32: number
  bytes: Buffer
}

/** 假表句柄：绑定表本身 + 断言用的观测接口。 */
export interface FakeWin32 {
  readonly bindings: FakeBindings
  /** 按调用顺序记录的 API 名（用于断言某条 API 没被调用）。 */
  readonly calls: string[]
  /** 覆盖实现里手动登记一次调用（覆盖项绕过了默认实现的记录）。 */
  record(api: string): void
  /** 当前 GetLastError 值。 */
  lastError(): number
  /** 设置 GetLastError 值。 */
  setLastError(code: number): void
  /** 写入一个指针出参槽。 */
  setPtr(slot: NativePtr, value: NativePtr | null): void
  /** 写入一个 uint32 槽。 */
  setUint32(slot: NativePtr, value: number): void
  /** 分配一块假原生字节并返回地址。 */
  allocBytesAt(bytes: Buffer): NativePtr
  /** 读某段假原生字节。 */
  bytesAt(ptr: NativePtr): Buffer
  /** 读 STARTUPINFOW 的字段（spawn 断言用）。 */
  startupInfoAt(ptr: NativePtr): StartupInfoFields
}

/**
 * 把 SDDL 字符串编码成 SID 字节。
 * @param sid - `S-1-5-21-...` 形态的 SID。
 * @returns 按 Windows 布局编码的字节。
 */
export function encodeSid(sid: string): Buffer {
  const match = /^S-(\d+)-(\d+)((?:-\d+)*)$/u.exec(sid)
  if (match === null) throw new Error(`test helper: not a SID string: ${sid}`)
  const revision = Number(match[1])
  const authority = BigInt(match[2] ?? '0')
  const subs = (match[3] ?? '').split('-').filter(part => part.length > 0).map(part => Number(part))
  const buffer = Buffer.alloc(8 + subs.length * 4)
  buffer.writeUInt8(revision, 0)
  buffer.writeUInt8(subs.length, 1)
  // identifierAuthority 是 6 字节大端（48 位），BigInt 的 8 字节里丢掉高 2 字节。
  const authorityBytes = Buffer.alloc(8)
  authorityBytes.writeBigUInt64BE(authority, 0)
  authorityBytes.subarray(2, 8).copy(buffer, 2)
  subs.forEach((sub, index) => {
    buffer.writeUInt32LE(sub, 8 + index * 4)
  })
  return buffer
}

/**
 * 创建一张全部成功的假绑定表；测试按需覆盖其中若干成员。
 * @param overrides - 覆盖项（例如 `{ lockFileEx: () => 0 }`）。
 * @returns 假表句柄。
 */
export function createFakeWin32(overrides: Partial<FakeBindings> = {}): FakeWin32 {
  const slots = new Map<bigint, FakeSlot>()
  const calls: string[] = []
  let nextAddress = 0x1000n
  let lastError = 5

  const record = (name: string): void => {
    calls.push(name)
  }
  const allocate = (bytes: Buffer): NativePtr => {
    const address = nextAddress
    nextAddress += 0x10n
    slots.set(address, { ptr: null, u32: 0, bytes })
    return address
  }
  const requireSlot = (ptr: NativePtr): FakeSlot => {
    const slot = slots.get(ptr)
    if (slot === undefined) throw new Error(`test fake: unknown native address ${ptr}`)
    return slot
  }
  const allocBytesAt = (bytes: Buffer): NativePtr => allocate(bytes)

  const bindings: FakeBindings = {
    /* 内存与解码 */
    allocPtrSlot: () => allocate(Buffer.alloc(0)),
    allocUint32: () => allocate(Buffer.alloc(0)),
    allocBytes: (length: number) => allocate(Buffer.alloc(length)),
    allocOverlapped: () => allocate(Buffer.alloc(32)),
    decodePtr: (slot: NativePtr) => requireSlot(slot).ptr,
    decodeUint32: (slot: NativePtr) => requireSlot(slot).u32,
    encodeUint32: (slot: NativePtr, value: number) => {
      requireSlot(slot).u32 = value
    },
    pointerAddress: (ptr: NativePtr) => ptr,
    decodePtrAt: (buffer: Buffer, offset: number) => {
      const value = buffer.readBigUInt64LE(offset)
      return value === 0n ? null : value
    },
    decodeUint8At: (ptr: NativePtr, offset: number) => requireSlot(ptr).bytes.readUInt8(offset),
    decodeUint16At: (ptr: NativePtr, offset: number) => requireSlot(ptr).bytes.readUInt16LE(offset),
    decodeUint32At: (ptr: NativePtr, offset: number) => requireSlot(ptr).bytes.readUInt32LE(offset),

    /* 通用 */
    getLastError: () => {
      record('getLastError')
      return lastError
    },
    formatMessageW: (win32Code: number) => {
      record('formatMessageW')
      return `synthetic system message for ${win32Code}`
    },
    closeHandle: () => {
      record('closeHandle')
      return 1
    },
    localFree: () => {
      record('localFree')
      return 0n
    },
    convertStringSidToSidW: (stringSid: string, sidSlot: NativePtr) => {
      record('convertStringSidToSidW')
      requireSlot(sidSlot).ptr = allocate(encodeSid(stringSid))
      return 1
    },

    /* ACL */
    getNamedSecurityInfoW: (
      _path: string,
      _objectType: number,
      _information: number,
      ownerSlot: NativePtr,
      groupSlot: NativePtr,
      daclSlot: NativePtr,
      saclSlot: NativePtr,
      descriptorSlot: NativePtr,
    ) => {
      record('getNamedSecurityInfoW')
      // 默认：目录没有显式 DACL（授予走「从零构造」的合并路径）。
      requireSlot(ownerSlot).ptr = null
      requireSlot(groupSlot).ptr = null
      requireSlot(daclSlot).ptr = null
      requireSlot(saclSlot).ptr = null
      requireSlot(descriptorSlot).ptr = null
      return 0
    },
    setEntriesInAclW: (_count: number, _entries: Buffer, _oldAcl: NativePtr | null, newAclSlot: NativePtr) => {
      record('setEntriesInAclW')
      requireSlot(newAclSlot).ptr = allocate(Buffer.alloc(32))
      return 0
    },
    setNamedSecurityInfoW: () => {
      record('setNamedSecurityInfoW')
      return 0
    },
    getTempPathW: (length: number, buffer: Buffer) => {
      record('getTempPathW')
      const temp = tmpdir().replace(/[\\/]$/u, '')
      void length
      buffer.write(temp, 'utf16le')
      return temp.length
    },
    createFileW: () => {
      record('createFileW')
      return 0x7777n
    },
    lockFileEx: () => {
      record('lockFileEx')
      return 1
    },
    unlockFileEx: () => {
      record('unlockFileEx')
      return 1
    },

    /* 令牌 */
    openProcess: () => {
      record('openProcess')
      return 0x100n
    },
    openProcessToken: (_process: NativePtr, _desiredAccess: number, tokenSlot: NativePtr) => {
      record('openProcessToken')
      requireSlot(tokenSlot).ptr = 0x200n
      return 1
    },
    createWellKnownSid: (type: number, _domainSid: null, sid: NativePtr, sizeSlot: NativePtr) => {
      record('createWellKnownSid')
      void type
      const bytes = encodeSid('S-1-1-0')
      bytes.copy(requireSlot(sid).bytes, 0)
      requireSlot(sizeSlot).u32 = bytes.length
      return 1
    },
    isValidSid: () => {
      record('isValidSid')
      return 1
    },
    getLengthSid: (sid: NativePtr) => {
      record('getLengthSid')
      const bytes = requireSlot(sid).bytes
      return bytes.length === 0 ? 8 : bytes.length
    },
    copySid: (length: number, destination: NativePtr, source: NativePtr) => {
      record('copySid')
      requireSlot(source).bytes.copy(requireSlot(destination).bytes, 0, 0, length)
      return 1
    },
    getTokenInformation: (token: NativePtr, infoClass: number, info: Buffer | null, length: number, neededSlot: NativePtr) => {
      record('getTokenInformation')
      void token
      void length
      if (infoClass === 2) {
        // TokenGroups：一个带 SE_GROUP_LOGON_ID 的 logon SID。
        const required = TOKEN_GROUPS_ENTRY_OFFSET + 16
        requireSlot(neededSlot).u32 = required
        if (info === null) return 0
        info.writeUInt32LE(1, 0)
        const logonSid = encodeSid('S-1-5-5-0-1234')
        info.writeBigUInt64LE(allocate(logonSid), TOKEN_GROUPS_ENTRY_OFFSET)
        info.writeUInt32LE(SE_GROUP_LOGON_ID, TOKEN_GROUPS_ENTRY_OFFSET + 8)
        return 1
      }
      if (infoClass === 6) {
        // TokenDefaultDacl：一个指向 ACL 的指针。
        requireSlot(neededSlot).u32 = 8
        if (info === null) return 0
        info.writeBigUInt64LE(allocate(Buffer.alloc(32)), 0)
        return 1
      }
      return 0
    },
    setTokenInformation: () => {
      record('setTokenInformation')
      return 1
    },
    createRestrictedToken: (
      _existing: NativePtr,
      _flags: number,
      _disableCount: number,
      _disableSids: null,
      _deletePrivilegeCount: number,
      _privilegesToDelete: null,
      _restrictCount: number,
      _restrictingSids: Buffer,
      newTokenSlot: NativePtr,
    ) => {
      record('createRestrictedToken')
      requireSlot(newTokenSlot).ptr = 0x400n
      return 1
    },

    /* 进程与 Job */
    createProcessAsUserW: (
      _token: NativePtr,
      _applicationName: string | null,
      _commandLine: string,
      _processAttributes: null,
      _threadAttributes: null,
      _inheritHandles: number,
      _creationFlags: number,
      _environment: null,
      _currentDirectory: string | null,
      _startupInfo: NativePtr,
      processInfo: NativePtr,
    ) => {
      record('createProcessAsUserW')
      const bytes = requireSlot(processInfo).bytes
      bytes.writeBigUInt64LE(0x500n, 0)
      bytes.writeBigUInt64LE(0x600n, 8)
      bytes.writeUInt32LE(4242, 16)
      bytes.writeUInt32LE(4243, 20)
      return 1
    },
    getStdHandle: (stdHandle: number) => {
      record('getStdHandle')
      return stdHandle === -10 ? 0x10n : stdHandle === -11 ? 0x11n : 0x12n
    },
    openNullInput: () => { record('openNullInput'); return 0x10n },
    setHandleInformation: () => {
      record('setHandleInformation')
      return 1
    },
    setConsoleCtrlHandler: () => {
      record('setConsoleCtrlHandler')
      return 1
    },
    createJobObjectW: () => {
      record('createJobObjectW')
      return 0x800n
    },
    setInformationJobObject: () => {
      record('setInformationJobObject')
      return 1
    },
    assignProcessToJobObject: () => {
      record('assignProcessToJobObject')
      return 1
    },
    resumeThread: () => {
      record('resumeThread')
      return 1
    },
    terminateProcess: () => {
      record('terminateProcess')
      return 1
    },
    waitForSingleObject: () => {
      record('waitForSingleObject')
      return 0
    },
    getExitCodeProcess: (_process: NativePtr, exitCodeSlot: NativePtr) => {
      record('getExitCodeProcess')
      requireSlot(exitCodeSlot).u32 = 7
      return 1
    },
    allocStartupInfo: () => allocate(Buffer.alloc(104)),
    encodeStartupInfo: (startupInfo: NativePtr, fields: StartupInfoFields) => {
      record('encodeStartupInfo')
      const bytes = requireSlot(startupInfo).bytes
      bytes.writeUInt32LE(fields.cb, 0)
      bytes.writeUInt32LE(fields.dwFlags, STARTUPINFO_FLAGS_OFFSET)
      bytes.writeBigUInt64LE(fields.hStdInput, STARTUPINFO_STDIN_OFFSET)
      bytes.writeBigUInt64LE(fields.hStdOutput, STARTUPINFO_STDIN_OFFSET + 8)
      bytes.writeBigUInt64LE(fields.hStdError, STARTUPINFO_STDIN_OFFSET + 16)
    },
    allocProcessInfo: () => allocate(Buffer.alloc(PROCESS_INFO_STRUCT_SIZE)),
    decodeProcessInfo: (processInfo: NativePtr): ProcessInfoFields => {
      record('decodeProcessInfo')
      const bytes = requireSlot(processInfo).bytes
      return {
        hProcess: bytes.readBigUInt64LE(0),
        hThread: bytes.readBigUInt64LE(8),
        dwProcessId: bytes.readUInt32LE(16),
        dwThreadId: bytes.readUInt32LE(20),
      }
    },

    ...overrides,
  }

  return {
    bindings,
    calls,
    record: (api: string) => {
      record(api)
    },
    lastError: () => lastError,
    setLastError: (code: number) => {
      lastError = code
    },
    setPtr: (slot: NativePtr, value: NativePtr | null) => {
      requireSlot(slot).ptr = value
    },
    setUint32: (slot: NativePtr, value: number) => {
      requireSlot(slot).u32 = value
    },
    allocBytesAt,
    bytesAt: (ptr: NativePtr) => requireSlot(ptr).bytes,
    startupInfoAt: (ptr: NativePtr): StartupInfoFields => {
      const bytes = requireSlot(ptr).bytes
      return {
        cb: bytes.readUInt32LE(0),
        dwFlags: bytes.readUInt32LE(STARTUPINFO_FLAGS_OFFSET),
        hStdInput: bytes.readBigUInt64LE(STARTUPINFO_STDIN_OFFSET),
        hStdOutput: bytes.readBigUInt64LE(STARTUPINFO_STDIN_OFFSET + 8),
        hStdError: bytes.readBigUInt64LE(STARTUPINFO_STDIN_OFFSET + 16),
      }
    },
  }
}

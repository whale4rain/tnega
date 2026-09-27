/**
 * Win32 绑定的可注入底座：内存读写、ACL 调用、koffi 惰性加载与「失败即抛」的错误助手。
 *
 * 为什么把内存读写也算进绑定表：失败路径必须在**任何平台**、且在没有安装 koffi 的宿主
 * 上可测，所以 koffi 只能出现在真实实现内部，绝不能出现在模块顶层 —— 否则 import 本
 * 模块就会拉起原生库。测试注入一张假表（{@link __setWin32BindingsForTest}）即可驱动
 * 每一条失败分支。
 *
 * 为什么不用 `import type ... from 'koffi'`：那会让编译期依赖 koffi 的类型声明；本包的
 * 纯逻辑（SID 派生、路径边界、runner 参数校验、失败分支）在没装 koffi 时也必须能编译、
 * 加载并通过测试。真实绑定在第一次真正需要时才解析 koffi。
 */

import { ACE_INLINE_SID_OFFSET, ACE_MASK_OFFSET, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, FORMAT_MESSAGE_BUFFER_BYTES, FORMAT_MESSAGE_FROM_SYSTEM, FORMAT_MESSAGE_IGNORE_INSERTS, MAX_PATH, OVERLAPPED_SIZE, SID_MAX_SUB_AUTHORITIES, SID_SUB_AUTHORITY_OFFSET } from './win32-abi.js'

/**
 * 原生指针。
 *
 * koffi 的 PVOID 是 64 位无符号整数，JS 侧用 `bigint` 表示（不是 `number`）；NULL 统一
 * 为 `0n`。用 `bigint` 而不是品牌类型，是为了让测试能直接用字面量构造假绑定，而不必靠
 * 类型断言绕过检查。
 */
export type NativePtr = bigint

/** 内存与解码原语。真实实现建立在 koffi 上，测试注入假实现。 */
export interface NativeMemory {
  /** 分配一个指针大小的出参槽。 */
  allocPtrSlot(): NativePtr
  /** 分配一个 uint32 出参槽。 */
  allocUint32(): NativePtr
  /** 分配一块原生字节。 */
  allocBytes(length: number): NativePtr
  /** 分配一块置零的 OVERLAPPED（koffi 3.1.x 不接受 NULL）。 */
  allocOverlapped(): NativePtr
  /** 读指针槽；地址 0 归一为 null。 */
  decodePtr(slot: NativePtr): NativePtr | null
  /** 读 uint32 槽。 */
  decodeUint32(slot: NativePtr): number
  /** 写 uint32 槽。 */
  encodeUint32(slot: NativePtr, value: number): void
  /** 取原生地址，用于把 SID 指针放进结构体。 */
  pointerAddress(ptr: NativePtr): bigint
  /** 从一段原生记录里读指针字段。 */
  decodePtrAt(buffer: Buffer, offset: number): NativePtr | null
  /** 从原生记录里读一个字节。 */
  decodeUint8At(ptr: NativePtr, offset: number): number
  /** 从原生记录里读一个 WORD。 */
  decodeUint16At(ptr: NativePtr, offset: number): number
  /** 从原生记录里读一个 DWORD。 */
  decodeUint32At(ptr: NativePtr, offset: number): number
}

/** 本包用到的 advapi32 / kernel32 调用。参数与返回值都是 JS 值，句柄用 {@link NativePtr}。 */
export interface Win32Functions {
  /** GetLastError。 */
  getLastError(): number
  /** FormatMessageW 的可读文本（查不到时返回空串）。 */
  formatMessageW(win32Code: number): string
  /** CloseHandle。 */
  closeHandle(handle: NativePtr): number
  /** LocalFree；成功返回 0n。 */
  localFree(memory: NativePtr): NativePtr
  /** ConvertStringSidToSidW：把 SDDL 字符串解析成 SID。 */
  convertStringSidToSidW(stringSid: string, sidSlot: NativePtr): number
  /** GetNamedSecurityInfoW。 */
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    ownerSlot: NativePtr,
    groupSlot: NativePtr,
    daclSlot: NativePtr,
    saclSlot: NativePtr,
    descriptorSlot: NativePtr,
  ): number
  /** SetEntriesInAclW：把一条 EXPLICIT_ACCESS_W 合并进旧 ACL。 */
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAclSlot: NativePtr): number
  /** SetNamedSecurityInfoW：把合并后的 ACL 写回对象。 */
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: null,
  ): number
  /** GetTempPathW。 */
  getTempPathW(length: number, buffer: Buffer): number
  /** CreateFileW（本包只用于锁文件）。 */
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr
  /** LockFileEx。 */
  lockFileEx(file: NativePtr, flags: number, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number
  /** UnlockFileEx。 */
  unlockFileEx(file: NativePtr, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number
}

/** 本包的绑定表：内存原语 + Win32 调用。 */
export type Win32Api = NativeMemory & Win32Functions

/** 一次 Win32 调用失败：带 API 名与精确错误码。 */
export class Win32Error extends Error {
  /** 失败的 Win32 函数名。 */
  readonly api: string
  /** GetLastError 值，或该 API 直接返回的错误码。 */
  readonly win32Code: number

  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'Win32Error'
    this.api = api
    this.win32Code = win32Code
  }
}

/** 指针是否为 NULL。 */
export function isNullPtr(value: NativePtr | null | undefined): boolean {
  return value === null || value === undefined || value === 0n
}

/**
 * CreateFileW 是否返回了 INVALID_HANDLE_VALUE。
 * @param handle - CreateFileW 的返回值。
 * @returns null、0 或全 1 哨兵都为「无效」。
 */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true
  return handle === 0xFFFFFFFFFFFFFFFFn || handle === -1n
}

/**
 * 按 koffi 的内存布局比较两个 SID 记录（不做字符串转换，也不需要 EqualSid）。
 * @param memory - 绑定表的内存原语。
 * @param left - 第一段原生内存。
 * @param leftOffset - 第一个 SID 的字节偏移。
 * @param right - 第二段原生内存。
 * @param rightOffset - 第二个 SID 的字节偏移。
 * @returns revision、authority 与每个子授权都相等时为 true。
 */
export function sameSidAt(
  memory: NativeMemory,
  left: NativePtr,
  leftOffset: number,
  right: NativePtr,
  rightOffset: number,
): boolean {
  if (memory.decodeUint8At(left, leftOffset) !== memory.decodeUint8At(right, rightOffset)) return false
  const leftCount = memory.decodeUint8At(left, leftOffset + 1)
  const rightCount = memory.decodeUint8At(right, rightOffset + 1)
  if (leftCount !== rightCount || leftCount > SID_MAX_SUB_AUTHORITIES) return false
  for (let index = 0; index < 6; index += 1) {
    if (memory.decodeUint8At(left, leftOffset + 2 + index) !== memory.decodeUint8At(right, rightOffset + 2 + index)) {
      return false
    }
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (memory.decodeUint32At(left, leftOffset + SID_SUB_AUTHORITY_OFFSET + index * 4)
      !== memory.decodeUint32At(right, rightOffset + SID_SUB_AUTHORITY_OFFSET + index * 4)) return false
  }
  return true
}

/**
 * 校验一个 ACE 是否就是本模块会写下的那条「完全一致」的授予。
 * @param memory - 绑定表的内存原语。
 * @param acl - ACL 指针。
 * @param aceOffset - ACE 起始偏移。
 * @param sid - 能力 SID 指针。
 * @param mask - 期望的访问掩码。
 * @param flags - 期望的继承标志。
 * @returns ACE 类型、标志、掩码与内联 SID 全部匹配时为 true。
 */
export function matchesGrantAce(
  memory: NativeMemory,
  acl: NativePtr,
  aceOffset: number,
  sid: NativePtr,
  mask: number,
  flags: number,
  aceType: number,
): boolean {
  // ACE_HEADER：AceType@0、AceFlags@1、AceSize@2；ACCESS_ALLOWED_ACE：Mask@4、内联 SID@8。
  return memory.decodeUint8At(acl, aceOffset) === aceType
    && memory.decodeUint8At(acl, aceOffset + 1) === flags
    && memory.decodeUint32At(acl, aceOffset + ACE_MASK_OFFSET) === mask
    && sameSidAt(memory, acl, aceOffset + ACE_INLINE_SID_OFFSET, sid, 0)
}

/** FormatMessageW 的可读文本；查不到系统文案时返回空串（错误里仍带错误码）。 */
export function errorText(api: Win32Api, win32Code: number): string {
  return api.formatMessageW(win32Code)
}

/**
 * 抛出当前 GetLastError 值。
 * @param api - 绑定表。
 * @param name - 失败的 Win32 操作名。
 * @param detail - 可选上下文（路径、pid、流程标签）。
 * @returns 永不返回。
 */
export function throwLastError(api: Win32Api, name: string, detail?: string): never {
  const win32Code = api.getLastError()
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

/**
 * 抛出调用点已经捕获到的错误码（清理动作不能再覆盖它）。
 * @param api - 绑定表。
 * @param name - 失败的 Win32 操作名。
 * @param win32Code - 在清理之前捕获的错误码。
 * @param detail - 可选上下文。
 * @returns 永不返回。
 */
export function throwWin32(api: Win32Api, name: string, win32Code: number, detail?: string): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

/**
 * 读取当前 Windows 临时目录（GetTempPathW）。
 * @param api - 绑定表。
 * @returns GetTempPathW 报告的 UTF-16 路径。
 */
export function getTempPath(api: Win32Api): string {
  const buffer = Buffer.alloc((MAX_PATH + 1) * 2)
  const length = api.getTempPathW(buffer.length / 2, buffer)
  if (length === 0) throwLastError(api, 'GetTempPathW')
  if (length > buffer.length / 2) {
    throw new Win32Error(
      'GetTempPathW',
      ERROR_INSUFFICIENT_BUFFER,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`,
    )
  }
  return buffer.subarray(0, length * 2).toString('utf16le')
}

/**
 * Ensure a Win32 error code is the success code.
 * @param api - 绑定表。
 * @param name - 失败的 Win32 操作名。
 * @param code - 该 API 直接返回的错误码。
 * @param detail - 可选上下文。
 */
export function assertSuccess(api: Win32Api, name: string, code: number, detail?: string): void {
  if (code !== ERROR_SUCCESS) throwWin32(api, name, code, detail)
}

/* ------------------------------ koffi 惰性加载 ------------------------------ */

/** koffi 类型描述符：本包只用到 size。 */
interface KoffiType {
  readonly size: number
}
/** 已加载的 DLL。 */
interface KoffiLibrary {
  func(
    convention: string,
    name: string,
    result: KoffiType | string,
    args: readonly (KoffiType | string)[],
  ): (...args: readonly unknown[]) => unknown
}
/** 本包用到的 koffi 表面。 */
interface KoffiModule {
  load(library: string): KoffiLibrary
  pointer(type: KoffiType | string): KoffiType
  alloc(type: KoffiType | string, count: number): unknown
  decode(value: unknown, offset: number, type: KoffiType | string): unknown
  encode(target: unknown, typeOrOffset: KoffiType | string | number, value: unknown): void
  address(pointer: unknown): unknown
}

function isKoffiModule(value: unknown): value is KoffiModule {
  if (typeof value !== 'object' || value === null) return false
  return ['load', 'pointer', 'alloc', 'decode', 'encode', 'address']
    .every(name => typeof Reflect.get(value, name) === 'function')
}

/** 把一个 koffi 返回值收敛成指针（NULL 归一为 0n）。 */
function asPointer(value: unknown, api: string): NativePtr {
  if (value === null || value === undefined) return 0n
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
  throw new Error(`koffi returned a non-pointer from ${api}`)
}

/** 把一个 koffi 返回值收敛成数字。 */
function asNumber(value: unknown, api: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error(`koffi returned a non-number from ${api}`)
}

/**
 * 解析 koffi。
 *
 * 说明符故意写成变量：编译期因此不会为 `koffi` 做模块解析，本包在没装 koffi（或非
 * Windows）的宿主上照样能编译、加载、跑纯逻辑测试；真正的原生库解析推迟到这一刻。
 * @returns 通过形状校验的 koffi 模块。
 */
async function loadKoffi(): Promise<KoffiModule> {
  const specifier = 'koffi'
  let loaded: unknown
  try {
    loaded = await import(specifier)
  } catch (error) {
    throw new Error(
      `could not load koffi: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const candidate: unknown = typeof loaded === 'object' && loaded !== null && 'default' in loaded
    ? Reflect.get(loaded, 'default')
    : loaded
  if (!isKoffiModule(candidate)) {
    throw new Error('koffi loaded but its export shape is unusable (load/pointer/alloc/decode/encode/address missing)')
  }
  return candidate
}

/**
 * 报告本机是否具备 ACL 机制的运行条件：平台是 win32，且 koffi 能被解析。
 *
 * **不抛**：这是给 Provider 用的探测入口，探测失败就是 false，由调用方决定呈现。
 * @returns 可运行时为 true。
 */
export async function isWindowsAclAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    await loadKoffi()
    return true
  } catch {
    return false
  }
}

/** 用 koffi 构造真实绑定表。 */
function createRealBindings(koffi: KoffiModule): Win32Api {
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const PVOID = koffi.pointer('void')
  const PPVOID = koffi.pointer(PVOID)
  const bind = (
    library: KoffiLibrary,
    name: string,
    result: KoffiType | string,
    args: readonly (KoffiType | string)[],
  ): ((...callArgs: readonly unknown[]) => unknown) => library.func('__stdcall', name, result, args)

  const closeHandle = bind(kernel32, 'CloseHandle', 'int', [PVOID])
  const getLastError = bind(kernel32, 'GetLastError', 'uint32', [])
  const localFree = bind(kernel32, 'LocalFree', PVOID, [PVOID])
  const convertStringSidToSidW = bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID])
  const getNamedSecurityInfoW = bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', [
    'str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID,
  ])
  const setEntriesInAclW = bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID])
  const setNamedSecurityInfoW = bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', [
    'str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID,
  ])
  const getTempPathW = bind(kernel32, 'GetTempPathW', 'uint32', ['uint32', PVOID])
  const createFileW = bind(kernel32, 'CreateFileW', PVOID, ['str16', 'uint32', 'uint32', PVOID, 'uint32', 'uint32', PVOID])
  const lockFileEx = bind(kernel32, 'LockFileEx', 'int', [PVOID, 'uint32', 'uint32', 'uint32', 'uint32', PVOID])
  const unlockFileEx = bind(kernel32, 'UnlockFileEx', 'int', [PVOID, 'uint32', 'uint32', 'uint32', PVOID])
  const formatMessageW = bind(kernel32, 'FormatMessageW', 'uint32', [
    'uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID,
  ])

  return {
    allocPtrSlot: () => asPointer(koffi.alloc(PVOID, 1), 'alloc'),
    allocUint32: () => asPointer(koffi.alloc('uint32', 1), 'alloc'),
    allocBytes: (length: number) => asPointer(koffi.alloc('uint8', length), 'alloc'),
    allocOverlapped: () => asPointer(koffi.alloc('uint8', OVERLAPPED_SIZE), 'alloc'),
    decodePtr: (slot: NativePtr) => {
      const value = asPointer(koffi.decode(slot, 0, PVOID), 'decode')
      return value === 0n ? null : value
    },
    decodeUint32: (slot: NativePtr) => asNumber(koffi.decode(slot, 0, 'uint32'), 'decode'),
    encodeUint32: (slot: NativePtr, value: number) => { koffi.encode(slot, 'uint32', value) },
    pointerAddress: (ptr: NativePtr) => asPointer(koffi.address(ptr), 'address'),
    decodePtrAt: (buffer: Buffer, offset: number) => {
      const value = asPointer(koffi.decode(buffer, offset, PVOID), 'decode')
      return value === 0n ? null : value
    },
    decodeUint8At: (ptr: NativePtr, offset: number) => asNumber(koffi.decode(ptr, offset, 'uint8'), 'decode'),
    decodeUint16At: (ptr: NativePtr, offset: number) => asNumber(koffi.decode(ptr, offset, 'uint16'), 'decode'),
    decodeUint32At: (ptr: NativePtr, offset: number) => asNumber(koffi.decode(ptr, offset, 'uint32'), 'decode'),
    getLastError: () => asNumber(getLastError(), 'GetLastError'),
    formatMessageW: (win32Code: number) => {
      const buffer = Buffer.alloc(FORMAT_MESSAGE_BUFFER_BYTES)
      const length = asNumber(
        formatMessageW(
          FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
          null,
          win32Code,
          0,
          buffer,
          buffer.length / 2,
          null,
        ),
        'FormatMessageW',
      )
      return length === 0 ? '' : buffer.subarray(0, length * 2).toString('utf16le').trim()
    },
    closeHandle: (handle: NativePtr) => asNumber(closeHandle(handle), 'CloseHandle'),
    localFree: (memory: NativePtr) => asPointer(localFree(memory), 'LocalFree'),
    convertStringSidToSidW: (stringSid: string, sidSlot: NativePtr) =>
      asNumber(convertStringSidToSidW(stringSid, sidSlot), 'ConvertStringSidToSidW'),
    getNamedSecurityInfoW: (
      path: string,
      objectType: number,
      information: number,
      ownerSlot: NativePtr,
      groupSlot: NativePtr,
      daclSlot: NativePtr,
      saclSlot: NativePtr,
      descriptorSlot: NativePtr,
    ) => asNumber(
      getNamedSecurityInfoW(path, objectType, information, ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot),
      'GetNamedSecurityInfoW',
    ),
    setEntriesInAclW: (count: number, entries: Buffer, oldAcl: NativePtr | null, newAclSlot: NativePtr) =>
      asNumber(setEntriesInAclW(count, entries, oldAcl, newAclSlot), 'SetEntriesInAclW'),
    setNamedSecurityInfoW: (
      path: string,
      objectType: number,
      information: number,
      owner: null,
      group: null,
      dacl: NativePtr | null,
      sacl: null,
    ) => asNumber(
      setNamedSecurityInfoW(path, objectType, information, owner, group, dacl, sacl),
      'SetNamedSecurityInfoW',
    ),
    getTempPathW: (length: number, buffer: Buffer) => asNumber(getTempPathW(length, buffer), 'GetTempPathW'),
    createFileW: (
      fileName: string,
      desiredAccess: number,
      shareMode: number,
      attributes: null,
      creationDisposition: number,
      flagsAndAttributes: number,
      templateFile: null,
    ) => asPointer(
      createFileW(fileName, desiredAccess, shareMode, attributes, creationDisposition, flagsAndAttributes, templateFile),
      'CreateFileW',
    ),
    lockFileEx: (file: NativePtr, flags: number, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr) =>
      asNumber(lockFileEx(file, flags, reserved, bytesLow, bytesHigh, overlapped), 'LockFileEx'),
    unlockFileEx: (file: NativePtr, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr) =>
      asNumber(unlockFileEx(file, reserved, bytesLow, bytesHigh, overlapped), 'UnlockFileEx'),
  }
}

let injected: Win32Api | undefined
let cached: Win32Api | undefined

/**
 * 注入一张假绑定表（测试专用）。
 *
 * 传 `undefined` 恢复真实实现。假的绑定表让「每条 API 失败分支」在任何平台、没有
 * koffi 的宿主上都能断言，而不必为了可测性放宽生产代码的错误处理。
 * @param bindings - 假表，或 undefined（恢复真实绑定）。
 */
export function __setWin32BindingsForTest(bindings: Win32Api | undefined): void {
  injected = bindings
}

/**
 * 取绑定表。第一次调用真实实现时才解析 koffi；注入的假表优先。
 * @returns 绑定表。
 */
export async function win32(): Promise<Win32Api> {
  if (injected !== undefined) return injected
  if (cached === undefined) {
    if (process.platform !== 'win32') {
      throw new Error('windows ACL bindings are only available on win32 hosts')
    }
    cached = createRealBindings(await loadKoffi())
  }
  return cached
}

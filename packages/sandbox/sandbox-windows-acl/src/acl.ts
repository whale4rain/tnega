/**
 * DACL 编辑：用 SetEntriesInAclW + SetNamedSecurityInfoW 在目录上授予/撤销能力 SID 的写 ACE。
 *
 * 并发：授予是「读当前 DACL → 合并 → 写回」，整段序列跑在每路径独占的 LockFileEx 锁下
 * （见 {@link withPathLock}），否则两个并发的 Provider 实例会互相覆盖对方的 ACE。
 *
 * 分配契约（参考实现踩过的坑）：GetNamedSecurityInfoW 返回的 ACL 指针位于安全描述符那块
 * 分配**内部**，只有描述符可以 LocalFree，而且在 SetEntriesInAclW 消费完旧 ACL 之前不能
 * 释放——释放 ACL 指针本身会破坏堆。合并出来的新 ACL 由调用方负责 LocalFree。
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { assertSuccess, getTempPath, isInvalidHandle, isNullPtr, matchesGrantAce, throwLastError, throwWin32 } from './ffi.js'
import type { NativePtr, Win32Api } from './ffi.js'
import * as abi from './win32-abi.js'

/**
 * 打包一条 EXPLICIT_ACCESS_W（48 字节，布局经参考实现的原生探针核对）：
 * grfAccessPermissions@0、grfAccessMode@4、grfInheritance@8、
 * Trustee@{ pMultipleTrustee@16、MultipleTrusteeOperation@24、TrusteeForm@28、
 * TrusteeType@32、ptstrName@40 }。
 * @param api - 绑定表。
 * @param sidPtr - 该条目指向的受托者 SID。
 * @param mode - GRANT_ACCESS 或 REVOKE_ACCESS。
 * @param permissions - 授予的访问掩码（REVOKE_ACCESS 时为 0，表示删除该受托者的全部 ACE）。
 * @returns 打包好的条目缓冲。
 */
export function buildExplicitAccess(api: Win32Api, sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8) // grfInheritance：OI|CI
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, abi.TRUSTEE_W_OFFSET + 8) // MultipleTrusteeOperation
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, abi.TRUSTEE_W_OFFSET + 12) // TrusteeForm
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, abi.TRUSTEE_W_OFFSET + 16) // TrusteeType
  entry.writeBigUInt64LE(api.pointerAddress(sidPtr), abi.TRUSTEE_W_OFFSET + abi.TRUSTEE_W_PTSTRNAME_OFFSET) // ptstrName = 能力 SID
  return entry
}

/**
 * 每个被保护的路径对应一个锁文件：`<GetTempPathW()>\tnega-acl-locks\<sha256(小写路径) 前 16 位>.lock`。
 *
 * 锁根取自 GetTempPathW（绝不取自 runner argv 或环境变量），小写化把 Windows 的大小写
 * 不敏感拼写归一到同一把锁上。
 * @param api - 绑定表。
 * @param path - 被保护的目录（绝对路径）。
 * @returns 该目录的锁文件路径。
 */
export function lockFilePath(api: Win32Api, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(getTempPath(api), 'tnega-acl-locks', `${digest}.lock`)
}

/**
 * 持有每路径独占锁执行 `action`。
 *
 * CreateFileW 用 OPEN_ALWAYS + 共享读写但**不共享删除**：可被删除的锁文件能够在持有者
 * 脚下被删掉重建，从而让两个进程同时「持有」同一把锁。随后在同步句柄上锁一个字节
 * （LOCKFILE_EXCLUSIVE_LOCK，置零的 OVERLAPPED 表示从偏移 0 开始）。失败一律抛出；即使
 * `action` 抛错也尽力解锁，且不覆盖原始错误。
 * @param api - 绑定表。
 * @param path - 被保护的目录（绝对路径）。
 * @param action - 需要串行化的「读-合并-写」序列。
 * @returns `action` 的结果。
 */
export function withPathLock<T>(api: Win32Api, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null,
    abi.OPEN_ALWAYS,
    0,
    null,
  )
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath)
  const overlapped = api.allocOverlapped() // 保持置零：偏移 0、hEvent NULL
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // 锁失败路径上的尽力清理
    throwWin32(api, 'LockFileEx', win32Code, lockPath)
  }

  let result: T
  try {
    result = action()
  } catch (error) {
    // action 失败时尽力解锁：清理失败不能掩盖 action 的错误。
    api.unlockFileEx(handle, 0, 1, 0, overlapped)
    api.closeHandle(handle)
    throw error
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // 解锁失败路径上的尽力清理
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath)
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`)
  return result
}

/**
 * 读目录当前的显式 DACL。
 * @param api - 绑定表。
 * @param path - 被读取的目录。
 * @returns 当前 DACL（目录没有显式 DACL 时为 null）与拥有它的安全描述符。
 */
function readCurrentDacl(api: Win32Api, path: string): { oldAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = api.allocPtrSlot()
  const groupSlot = api.allocPtrSlot()
  const daclSlot = api.allocPtrSlot()
  const saclSlot = api.allocPtrSlot()
  const descriptorSlot = api.allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path,
    abi.SE_FILE_OBJECT,
    abi.DACL_SECURITY_INFORMATION,
    ownerSlot,
    groupSlot,
    daclSlot,
    saclSlot,
    descriptorSlot,
  )
  assertSuccess(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: api.decodePtr(daclSlot), descriptor: api.decodePtr(descriptorSlot) }
}

/** 释放描述符分配（旧 ACL 也在其中），失败即抛。 */
function freeDescriptor(api: Win32Api, descriptor: NativePtr | null, label: string): void {
  if (descriptor === null) return
  if (!isNullPtr(api.localFree(descriptor))) throwLastError(api, 'LocalFree', label)
}

/**
 * grantWrite 与 revokeWrite 的公共尾部：把 `entry` 合并进 `oldAcl`（null 表示还没有显式
 * DACL，SetEntriesInAclW 会从零构造），在应用之前释放描述符，应用之后再释放合并出来的
 * ACL，每一步都检查并按调用方的标签报告失败。
 * @param api - 绑定表。
 * @param path - 被编辑的目录。
 * @param entry - 要合并的 EXPLICIT_ACCESS_W。
 * @param oldAcl - 当前显式 DACL。
 * @param descriptor - 拥有 `oldAcl` 的描述符分配。
 * @param label - 调用方的流程名（grantWrite / revokeWrite），用于错误上下文。
 */
function mergeAndApply(
  api: Win32Api,
  path: string,
  entry: Buffer,
  oldAcl: NativePtr | null,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = api.allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    freeDescriptorBestEffort(api, descriptor)
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = api.decodePtr(newAclSlot)
  if (newAcl === null) {
    const win32Code = api.getLastError()
    freeDescriptorBestEffort(api, descriptor)
    throwWin32(api, 'SetEntriesInAclW', win32Code, `${label}(${path}): null new ACL`)
  }

  // 合并之后描述符那块内存（连同 oldAcl）就作废了：在应用之前释放它。
  const freedDescriptor = descriptor === null ? null : api.localFree(descriptor)
  const applyResult = api.setNamedSecurityInfoW(
    path,
    abi.SE_FILE_OBJECT,
    abi.DACL_SECURITY_INFORMATION,
    null,
    null,
    newAcl,
    null,
  )
  const freedNewAcl = api.localFree(newAcl)
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
  if (!isNullPtr(freedNewAcl)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)
}

/** 已经在报错的路径上：释放失败不能覆盖原始错误。 */
function freeDescriptorBestEffort(api: Win32Api, descriptor: NativePtr | null): void {
  if (descriptor === null) return
  api.localFree(descriptor)
}

/**
 * 当前显式 DACL 里是否已经存在本模块会写下的那条「完全一致」的 ACE。
 *
 * ACE 的 SID 是内联的（掩码之后紧跟 SID 字节，没有指针可读；照指针读会拿到垃圾地址），
 * 所以按偏移逐字段比较。头部数据不可信时返回 false，让调用方回落到合并-应用路径——那
 * 条路径自带完整的错误处理。
 * @param api - 绑定表。
 * @param oldAcl - 当前显式 DACL。
 * @param sidPtr - 要匹配的能力 SID。
 * @returns 完全一致的授予 ACE 是否已经在位。
 */
function hasExactGrant(api: Win32Api, oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = api.decodeUint16At(oldAcl, 2)
  const aceCount = api.decodeUint16At(oldAcl, 4)
  if (aclSize < abi.ACL_HEADER_SIZE || aclSize > 1_048_576) return false // 不合理：回落到合并路径
  let offset = abi.ACL_HEADER_SIZE
  for (let index = 0; index < aceCount; index += 1) {
    const aceSize = api.decodeUint16At(oldAcl, offset + 2)
    if (aceSize < abi.ACE_INLINE_SID_OFFSET || offset + aceSize > aclSize) return false // 不合理：回落到合并路径
    if (matchesGrantAce(
      api,
      oldAcl,
      offset,
      sidPtr,
      abi.GRANT_MASK,
      abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
      abi.ACCESS_ALLOWED_ACE_TYPE,
    )) return true
    offset += aceSize
  }
  return false
}

/**
 * 给 `path` 上的能力 SID 授予 {@link abi.GRANT_MASK}（写 + 删 + 删子项，显示为 Modify），
 * 并向子容器与子对象继承。
 *
 * 幂等：目录当前显式 DACL 里已经有完全一致的 ACE 时（跨 Provider 存活的常驻授予），
 * **跳过** SetNamedSecurityInfoW —— 否则会把同一条 ACE 在整个树上重新传播一遍（大仓库
 * 上要几分钟）。否则读-合并-写：新 ACE 合并进目录**当前**的显式 DACL，已有的显式 ACE
 * 因此得以保留。整个序列在每路径锁下运行。
 *
 * 前置条件（与参考实现相同）：目录的所有者是调用者（所有者隐含 WRITE_DAC）。
 * @param api - 绑定表。
 * @param path - 要授予的目录（workspace 或私有 temp 根）。
 * @param sidPtr - ACE 指向的能力 SID。
 */
export function grantWrite(api: Win32Api, path: string, sidPtr: NativePtr): void {
  withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path)
    if (oldAcl !== null && hasExactGrant(api, oldAcl, sidPtr)) {
      // 完全一致的 ACE 已经在位：释放描述符就是全部工作。
      freeDescriptor(api, descriptor, `grantWrite(${path}) descriptor`)
      return
    }
    mergeAndApply(api, path, buildExplicitAccess(api, sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK), oldAcl, descriptor, 'grantWrite')
  })
}

/**
 * 从目录 DACL 中删除该能力 SID 的全部 ACE（REVOKE_ACCESS 合并，其它条目保留）。
 *
 * 同样跑在每路径锁下；分配的契约见 {@link readCurrentDacl}。
 * @param api - 绑定表。
 * @param path - 要撤销的目录。
 * @param sidPtr - 要移除 ACE 的能力 SID。
 * @returns 是否真的尝试了删除（目录完全没有 DACL 时为 false）。
 */
export function revokeWrite(api: Win32Api, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, path)
    if (oldAcl === null) {
      freeDescriptor(api, descriptor, `revokeWrite(${path}) descriptor`)
      return false
    }
    mergeAndApply(api, path, buildExplicitAccess(api, sidPtr, abi.REVOKE_ACCESS, 0), oldAcl, descriptor, 'revokeWrite')
    return true
  })
}

/**
 * 读真实目录 DACL 的测试助手（Windows-only 用例共用）。
 *
 * 用本包自己的绑定把安全描述符读回来，再用内存解码原语逐字段解析——因此测试不引入
 * 任何额外的原生依赖（不 import koffi），也不需要把 SID 映射成账户名。
 */

import { assertSuccess } from '../../src/ffi.js'
import type { NativePtr, Win32Api } from '../../src/ffi.js'
import * as abi from '../../src/win32-abi.js'

/** 一条 ACE（继承而来的也会被列出）。 */
export interface AclAce {
  sid: string
  mask: number
  flags: number
  inherited: boolean
}

/** 把原生内存里的 SID 记录读成 SDDL 字符串。 */
export function sidAt(api: Win32Api, ptr: NativePtr, offset: number): string {
  const revision = api.decodeUint8At(ptr, offset)
  const count = api.decodeUint8At(ptr, offset + 1)
  let authority = 0n
  for (let index = 0; index < 6; index += 1) {
    authority = (authority << 8n) | BigInt(api.decodeUint8At(ptr, offset + 2 + index))
  }
  const subs: string[] = []
  for (let index = 0; index < count; index += 1) subs.push(String(api.decodeUint32At(ptr, offset + 8 + index * 4)))
  return `S-${revision}-${authority}${subs.length > 0 ? `-${subs.join('-')}` : ''}`
}

/**
 * 读目录的 ACE 列表。
 *
 * ACE 头是 AceType@0、AceFlags@1、AceSize@2，ACCESS_ALLOWED_ACE 的掩码@4、内联 SID@8。
 * ACL 指针位于描述符分配内部，只能释放描述符。
 * @param api - 绑定表。
 * @param path - 被读取的目录。
 * @param includeInherited - 是否把继承而来的 ACE 也算进去（默认 false）。
 * @returns 显式（默认）或全部 ACE。
 */
export function readAces(api: Win32Api, path: string, includeInherited = false): AclAce[] {
  const ownerSlot = api.allocPtrSlot()
  const groupSlot = api.allocPtrSlot()
  const daclSlot = api.allocPtrSlot()
  const saclSlot = api.allocPtrSlot()
  const descriptorSlot = api.allocPtrSlot()
  const result = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  assertSuccess(api, 'GetNamedSecurityInfoW', result, path)
  const acl = api.decodePtr(daclSlot)
  const descriptor = api.decodePtr(descriptorSlot)
  try {
    if (acl === null) return []
    const aclSize = api.decodeUint16At(acl, 2)
    const aceCount = api.decodeUint16At(acl, 4)
    const aces: AclAce[] = []
    let offset = abi.ACL_HEADER_SIZE
    for (let index = 0; index < aceCount; index += 1) {
      const flags = api.decodeUint8At(acl, offset + 1)
      const aceSize = api.decodeUint16At(acl, offset + 2)
      if (aceSize <= 0 || offset + aceSize > aclSize) break
      const inherited = (flags & abi.INHERITED_ACE) !== 0
      if (includeInherited || !inherited) {
        aces.push({
          sid: sidAt(api, acl, offset + abi.ACE_INLINE_SID_OFFSET),
          mask: api.decodeUint32At(acl, offset + abi.ACE_MASK_OFFSET),
          flags,
          inherited,
        })
      }
      offset += aceSize
    }
    return aces
  } finally {
    if (descriptor !== null) api.localFree(descriptor)
  }
}

/** 掩码里任何一位「写」都算写授权：写数据/追加/写属性/删除/删子项。 */
const WRITE_BITS = 0x116 | abi.DELETE | abi.FILE_DELETE_CHILD

/**
 * 该目录是否给 Everyone 授予了写权限（含继承 ACE）。
 *
 * 为什么只看 Everyone：写入侧的 pass-2 检查是拿 restricting SID **列表**去比对象 DACL 的，
 * 而两种模式的列表里唯一可能被普通目录授予写的环境身份就是 Everyone（logon SID 只出现在
 * 每次登录的对象上）。INTERACTIVE/LOCAL 不在列表里，它们给了写权限也不生效——这正是
 * 「Public 树写被拒」的来源。
 *
 * README 把 Everyone 列为已知边界；测试用这个判据决定「环境的 Everyone 边界是否会让某条
 * 断言失去意义」。
 * @param api - 绑定表。
 * @param path - 被检查的目录。
 * @returns Everyone 可写时为 true。
 */
export function writeIsAmbientlyAllowed(api: Win32Api, path: string): boolean {
  const worldSid = 'S-1-1-0'
  return readAces(api, path, true).some(ace => ace.sid === worldSid && (ace.mask & WRITE_BITS) !== 0)
}

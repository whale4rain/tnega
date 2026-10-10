/**
 * 一个写 SID 的授予物（grant）：解析后的 SID 指针，加上当前 DACL 里带它 ACE 的目录清单。
 *
 * 生命周期语义是这套机制的核心：
 *
 * - **workspace 路径是常驻的（standing）**：它的 ACE 就是跨 session 的复用缓存，活得比
 *   任何 grant 长——`dispose()` 刻意不撤销它（撤销会让下一次供给重新传播整棵树）。
 * - **temp 路径是可撤销的（revocable）**：继承性 ACE 不能活得比它所属 session 的 temp
 *   目录更久，`dispose()` 会撤销它们。
 *
 * fail-closed：`add` 的任何失败都抛出，调用方随后 `dispose()` 以撤销已经授予的路径；
 * `dispose()` 撤销全部可撤销路径、释放 SID，并汇报每一次清理失败。
 *
 * 授予/撤销默认是调用线程里的同步 Win32 调用。在一棵还没有该 ACE 的大树上，
 * SetNamedSecurityInfoW 的继承传播能跑几十分钟，所以 Provider 应当传入
 * {@link AclWriteGrantCreateOptions.operate}，把它交给 helper 进程（见 `src/grant-command.ts`）——
 * 桌面端的调用线程就是 Electron 主进程。
 */

import { grantWrite, revokeWrite } from './acl.js'
import { isNullPtr, throwLastError, throwWin32, win32 } from './ffi.js'
import type { NativePtr, Win32Api } from './ffi.js'
import type { AclOperation, AclOperationRunner } from './grant-command.js'

/** {@link AclWriteGrant.add} 的选项。 */
export interface AclWriteGrantAddOptions {
  /**
   * 该路径的 ACE 是否随 `dispose()` 撤销。
   *
   * 默认 false（常驻）—— workspace 的复用缓存语义；私有 temp 目录必须传 true。
   */
  revocable?: boolean
}

/** {@link AclWriteGrant.create} 的选项。 */
export interface AclWriteGrantCreateOptions {
  /**
   * 执行每一次授予/撤销的函数，例如在 helper 进程里运行（见 `src/grant-command.ts`）。
   *
   * 省略时在调用线程内同步执行。
   */
  operate?: AclOperationRunner
}

/** 从数组里删掉某个路径的全部出现。 */
function dropPath(paths: string[], path: string): void {
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    if (paths[index] === path) paths.splice(index, 1)
  }
}

/**
 * 一个写 SID 的授予物。用 {@link AclWriteGrant.create} 构造；`dispose()` 撤销可撤销路径、
 * 保留常驻路径，并释放 SID。
 */
export class AclWriteGrant {
  /** 写 SID 的 SDDL 字符串形式。 */
  readonly writeSid: string
  private readonly api: Win32Api
  private readonly sidPtr: NativePtr
  private readonly operate: AclOperationRunner | undefined
  private readonly revocablePaths: string[] = []
  private readonly standingPaths: string[] = []
  private disposed = false

  private constructor(api: Win32Api, sidPtr: NativePtr, writeSid: string, operate: AclOperationRunner | undefined) {
    this.api = api
    this.sidPtr = sidPtr
    this.writeSid = writeSid
    this.operate = operate
  }

  /**
   * 解析 SID 字符串并准备绑定表（惰性，每个进程一次）。
   *
   * fail-closed：任何失败都抛出，此时还没有授予任何 ACE。
   * @param writeSid - workspace（`S-1-4-x-y`）或 temp（`S-1-4-x-y-1`）的能力 SID 字符串。
   * @param options - 可选的操作执行者。
   * @returns 就绪的授予物（尚无 ACE）。
   */
  static async create(writeSid: string, options: AclWriteGrantCreateOptions = {}): Promise<AclWriteGrant> {
    const api = await win32()
    const sidSlot = api.allocPtrSlot()
    if (api.convertStringSidToSidW(writeSid, sidSlot) === 0) {
      throwLastError(api, 'ConvertStringSidToSidW', writeSid)
    }
    const sidPtr = api.decodePtr(sidSlot)
    if (sidPtr === null) throwWin32(api, 'ConvertStringSidToSidW', api.getLastError(), `null SID for ${writeSid}`)
    return new AclWriteGrant(api, sidPtr, writeSid, options.operate)
  }

  /** 执行一次授予/撤销：交给注入的执行者，否则在调用线程内执行。 */
  private async perform(kind: AclOperation['kind'], path: string): Promise<boolean> {
    if (this.operate !== undefined) return this.operate({ kind, path, writeSid: this.writeSid })
    if (kind === 'grant') {
      grantWrite(this.api, path, this.sidPtr)
      return true
    }
    return revokeWrite(this.api, path, this.sidPtr)
  }

  /**
   * 在一个目录上落下写 ACE（幂等：完全一致的 ACE 已在位时只读一次 DACL，见
   * {@link grantWrite}），并登记该路径供 {@link dispose} 处理。
   *
   * 路径在授予**之前**登记：写成功之后仍可能抛错（例如 LocalFree 失败），调用方必须
   * 仍然能撤销这条路径（撤销一条没授予过的路径是一次无害的空合并）。
   * @param path - 要授予的目录（必须存在，且所有者是调用者）。
   * @param options - `revocable: true` 表示 ACE 随 dispose 撤销。
   */
  async add(path: string, options?: AclWriteGrantAddOptions): Promise<void> {
    if (this.disposed) throw new Error('AclWriteGrant is already disposed')
    const target = (options?.revocable ?? false) ? this.revocablePaths : this.standingPaths
    target.push(path)
    await this.perform('grant', path)
  }

  /**
   * 显式撤销一个路径上的该 SID 的全部 ACE，并把它移出登记表。
   * @param path - 要撤销的目录。
   */
  async revoke(path: string): Promise<void> {
    if (this.disposed) throw new Error('AclWriteGrant is already disposed')
    await this.perform('revoke', path)
    dropPath(this.revocablePaths, path)
    dropPath(this.standingPaths, path)
  }

  /** 当前登记的目录，常驻在前、可撤销在后。 */
  get paths(): readonly string[] {
    return [...this.standingPaths, ...this.revocablePaths]
  }

  /**
   * 撤销全部可撤销的授予（常驻 ACE 保留——它们是预期终态，不是错误残留），并释放 SID。
   *
   * 汇报每一次清理失败（AggregateError）；重复调用是无操作。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const failures: unknown[] = []
    for (const path of this.revocablePaths) {
      try {
        await this.perform('revoke', path)
      } catch (error) {
        failures.push(error)
      }
    }
    this.revocablePaths.length = 0
    try {
      const freed = this.api.localFree(this.sidPtr)
      if (!isNullPtr(freed)) throwLastError(this.api, 'LocalFree', 'write SID')
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`)
    }
  }
}

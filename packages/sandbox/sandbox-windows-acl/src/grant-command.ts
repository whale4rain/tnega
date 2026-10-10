/**
 * 把 DACL 授予/撤销挪进一个独立的 helper 进程。
 *
 * 为什么：{@link grantWrite} 在一棵还没有该 ACE 的树上调用 SetNamedSecurityInfoW 时，内核要
 * 把可继承 ACE 同步传播到整棵树——大仓库上能跑几十分钟。桌面端把整个 Agent Runtime 跑在
 * Electron 主进程里，这段同步调用会冻结 UI 消息泵和本地 server（窗口显示「未响应」）。所以
 * Provider 把每一次授予/撤销交给一个一次性的 helper 进程（`src/grant-entry.ts`），自己只
 * await 结果；helper 的启动方式与 runner 相同（Electron 下以 Node 模式运行）。
 *
 * helper 只有发布形态：根包构建 `dist/sandbox-windows-acl-grant.js`，桌面端构建
 * `out/sandbox-windows-acl-grant.js`，都与打进去的包入口同目录。仓库内 dev / vitest 形态没有
 * 这份产物——Node 的类型剥离不会把 `./acl.js` 映射到 `./acl.ts`，`grant-entry.ts` 不能直接
 * 运行——此时 {@link resolveGrantCommand} 返回 undefined，授予退回在调用进程内执行。
 *
 * ## 协议
 *
 * ```text
 * [node, <helper>, <grant|revoke>, <目录>, <能力 SID>]
 * ```
 *
 * helper 在 stdout 写一行 JSON（{@link AclOperationReply}），成功退出 0、失败退出 1。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Win32Error } from './ffi.js'

/** 发布形态的 helper 文件名（与本模块同目录）。 */
const PUBLISHED_GRANT_FILE = './sandbox-windows-acl-grant.js'

/** 一次 DACL 操作。 */
export interface AclOperation {
  kind: 'grant' | 'revoke'
  /** 要编辑的目录。 */
  path: string
  /** ACE 指向的能力 SID 字符串（helper 自己转换成 SID）。 */
  writeSid: string
}

/** 执行一次 DACL 操作的函数；返回值在撤销时表示是否真的尝试了删除。 */
export type AclOperationRunner = (operation: AclOperation) => Promise<boolean>

/** helper 回传的结果：成功带操作的返回值，失败带可重建的错误字段。 */
export type AclOperationReply =
  | { ok: true; value: boolean }
  | { ok: false; message: string; api?: string; win32Code?: number }

/** helper 进程的退出结果（`@tnega/execution` 的 ProcessResult 的子集）。 */
export interface GrantProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** {@link resolveGrantCommand} 的选项。 */
export interface ResolveGrantCommandOptions {
  /** 解析锚点，默认本模块的 `import.meta.url`；只用于测试。 */
  moduleUrl?: string | URL
}

/**
 * 找到发布形态的 helper。
 * @param options - 测试用的解析锚点。
 * @returns `[process.execPath, <helper 绝对路径>]`；仓库内 dev 形态没有 helper 时为 undefined。
 */
export function resolveGrantCommand(options: ResolveGrantCommandOptions = {}): readonly string[] | undefined {
  const candidate = fileURLToPath(new URL(PUBLISHED_GRANT_FILE, options.moduleUrl ?? import.meta.url))
  return existsSync(candidate) ? [process.execPath, candidate] : undefined
}

/**
 * helper 命令行里跟在 helper 路径后面的参数。
 * @param operation - 要执行的操作。
 * @returns `[kind, path, writeSid]`。
 */
export function grantCommandArgs(operation: AclOperation): string[] {
  return [operation.kind, operation.path, operation.writeSid]
}

/**
 * 解析 helper 的命令行参数（helper 侧使用）。
 * @param args - `process.argv.slice(2)`。
 * @returns 操作；参数不合法时为 undefined。
 */
export function parseGrantCommandArgs(args: readonly string[]): AclOperation | undefined {
  const [kind, path, writeSid] = args
  if (args.length !== 3 || (kind !== 'grant' && kind !== 'revoke') || !path || !writeSid) return undefined
  return { kind, path, writeSid }
}

/**
 * 把错误收敛成可跨进程传递的回传（helper 侧使用）。
 * @param error - 操作抛出的错误。
 * @returns 失败回传；Win32Error 保留 API 名与错误码。
 */
export function failureReply(error: unknown): AclOperationReply {
  if (error instanceof Win32Error) return { ok: false, message: error.message, api: error.api, win32Code: error.win32Code }
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

/** 一行 JSON 是否是合法的回传。 */
function isReply(value: unknown): value is AclOperationReply {
  if (typeof value !== 'object' || value === null) return false
  const ok: unknown = Reflect.get(value, 'ok')
  if (ok === true) return typeof Reflect.get(value, 'value') === 'boolean'
  if (ok !== false || typeof Reflect.get(value, 'message') !== 'string') return false
  const api: unknown = Reflect.get(value, 'api')
  const code: unknown = Reflect.get(value, 'win32Code')
  return (api === undefined || typeof api === 'string') && (code === undefined || typeof code === 'number')
}

/**
 * 解读 helper 的退出结果：成功返回操作的返回值，否则抛出（fail closed）。
 *
 * Win32 失败还原成 {@link Win32Error}（保留 API 名与错误码）；没有合法回传的退出（崩溃、
 * 被杀、加载失败）带上 stderr 抛出。
 * @param result - helper 的退出码与输出。
 * @param operation - 发出的操作，用于错误上下文。
 * @returns 操作的返回值。
 */
export function parseGrantReply(result: GrantProcessResult, operation: AclOperation): boolean {
  const line = result.stdout.trim().split(/\r?\n/u).at(-1) ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    parsed = undefined
  }
  if (isReply(parsed)) {
    if (parsed.ok && result.exitCode === 0) return parsed.value
    if (!parsed.ok) {
      if (parsed.api === undefined || parsed.win32Code === undefined) throw new Error(parsed.message)
      const error = new Win32Error(parsed.api, parsed.win32Code)
      error.message = parsed.message
      throw error
    }
  }
  const detail = result.stderr.trim() || result.stdout.trim() || 'no output'
  throw new Error(`windows ACL ${operation.kind} helper exited ${result.exitCode} without a result for ${operation.path}: ${detail}`)
}

import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  canonicalPath,
  writableRoots,
  type SandboxExecutionPolicy,
} from '@tnega/sandbox'
import { isPathUnder } from './containment.js'

export * from './containment.js'
export { canonicalPath, writableRoots } from '@tnega/sandbox'

/**
 * fs 侧路径围栏的稳定错误码。
 *
 * - `FS_PATH_INVALID`：输入本身不合法（空、根不可访问）。
 * - `FS_PATH_ESCAPES_WORKSPACE`：路径逃出工作区（含 `..` 与 symlink 两种途径）。
 * - `FS_SANDBOX_DENIED`：路径没逃出去，但当前策略不允许这次写入。
 */
export type PathSandboxErrorCode =
  | 'FS_PATH_INVALID'
  | 'FS_PATH_ESCAPES_WORKSPACE'
  | 'FS_SANDBOX_DENIED'

/** 路径被 fs 围栏拒绝。带稳定码，便于工具层渲染成模型可见的拒绝标记。 */
export class PathSandboxError extends Error {
  override name = 'PathSandboxError'

  constructor(
    message: string,
    readonly code: PathSandboxErrorCode = 'FS_PATH_ESCAPES_WORKSPACE',
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 把一个可能相对的输入解析成**工作区之内**的绝对路径。
 *
 * 两道检查缺一不可：
 *
 * 1. 词法 + 身份包含判定（{@link isPathUnder}）挡住 `..`、绝对路径与 Windows 的
 *    8.3 / 大小写别名。
 * 2. 沿**最深的已存在祖先**逐个 `realpath`，挡住「父目录是 symlink，指向工作区之外」——
 *    第一种检查看不出这种逃逸，因为它比较的是拼写。
 *
 * 返回值是词法目标（不是 realpath）：调用方需要的是可打开的那条路径，而验证用的是
 * 它的真身。这与 `@tnega/tools` 里文件工具的既有语义一致。
 */
export async function resolveInside(cwd: string, input: string): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new PathSandboxError('path must be a non-empty string', 'FS_PATH_INVALID')
  }
  let root: string
  try {
    root = await realpath(cwd)
  } catch {
    throw new PathSandboxError(`workspace directory is not accessible: ${cwd}`, 'FS_PATH_INVALID')
  }
  const target = resolve(cwd, input)
  if (!isPathUnder(target, root)) {
    throw new PathSandboxError(`path escapes the workspace: ${input}`)
  }

  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      if (!isPathUnder(real, root)) {
        throw new PathSandboxError(`path escapes the workspace through a symlink: ${input}`)
      }
      return target
    } catch (error) {
      if (!isMissing(error)) throw error
      const parent = dirname(current)
      if (parent === current) {
        throw new PathSandboxError(`path escapes the workspace: ${input}`)
      }
      current = parent
    }
  }
}

/**
 * 这次写入在当前策略下是否被允许。这是**同一份** `writableRoots` 判定的非抛出形态，
 * Provider 用它推导 mount / ACL 授权，工具层用它渲染拒绝原因。
 *
 * `read-only` 一律拒绝写；`workspace-write` 只允许可写根之内；`bypass` 表示不沙箱，
 * 一律允许 —— 是否真的给 `bypass` 由调用方（composition / 权限预设）决定。
 */
export function isWritablePath(target: string, policy: SandboxExecutionPolicy): boolean {
  if (policy.mode === 'bypass') return true
  if (policy.mode === 'read-only') return false
  const roots = writableRoots(policy)
  const canonical = canonicalPath(target)
  return roots.some(root => isPathUnder(canonical, root))
}

/**
 * {@link isWritablePath} 的抛出形态。
 *
 * @throws PathSandboxError `FS_SANDBOX_DENIED`：拒绝原因写入 message，包含当前模式。
 */
export function assertWritablePath(target: string, policy: SandboxExecutionPolicy): void {
  if (isWritablePath(target, policy)) return
  throw new PathSandboxError(
    `cannot write "${target}": file access denied under ${policy.mode} mode`,
    'FS_SANDBOX_DENIED',
  )
}

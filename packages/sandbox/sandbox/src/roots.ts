import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { type SandboxExecutionPolicy } from './types.js'

/**
 * 路径的文件系统真身。解析失败（路径还不存在）时按原拼写返回 —— 这个函数的用途是
 * 给出**稳定且可比较**的键，不是证明路径存在。
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * 策略的可写根集合。这是 Provider（mount 绑定、ACL 授权）与 fs 围栏
 * （`@tnega/fs-sandbox`）**共用的同一份** allow-list 来源：两边各写一份必然漂移，
 * 最后表现为「`write_file` 写不进去但 shell 能写」这类不对称。
 *
 * - `read-only` / `bypass` 都返回空集：前者是不许写，后者是「不沙箱」，两者都不该
 *   出现在任何授权里。
 * - POSIX 的 `workspace-write` 还给出 `/tmp` 与 `os.tmpdir()`：git、编译器、包管理器
 *   都依赖一个可写临时区，不给就会把「能构建」变成「不能构建」。
 * - Windows 只给 `os.tmpdir()` 或显式 `tempRoot`：那里没有 `/tmp`，而且 Windows ACL
 *   是按路径授权的，多给一个不存在的路径只会让授权步骤失败。
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const roots = [policy.workspaceRoot]
  if (policy.tempRoot !== undefined) {
    roots.push(policy.tempRoot)
  } else if (process.platform === 'win32') {
    roots.push(tmpdir())
  } else {
    roots.push('/tmp', tmpdir())
  }
  return [...new Set(roots.map(canonicalPath))]
}

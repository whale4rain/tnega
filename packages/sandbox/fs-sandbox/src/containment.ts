import { statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 路径包含判定：先做词法快路径，再做文件系统身份回退。
 *
 * 只做词法比较会在 Windows 上漏掉两类别名：8.3 短名与大小写不同的拼写。身份回退比较
 * `dev` + `ino`，因此「同一个目录的另一种写法」仍然算在根之内，而不需要用「文本近似」
 * 去放宽包含性。
 *
 * 根不存在时返回 `false`：判不出来时按不包含处理（fail closed）。
 */
export function isPathUnder(
  path: string,
  root: string,
  caseSensitive: boolean = process.platform !== 'win32',
): boolean {
  if (isLexicallyUnder(path, root, caseSensitive)) return true
  return isIdentityUnder(path, root)
}

/** 只做字符串比较的那一半，可单独用于「拼写已经一致」的快路径。 */
export function isLexicallyUnder(
  path: string,
  root: string,
  caseSensitive: boolean = process.platform !== 'win32',
): boolean {
  const target = caseSensitive ? path : path.toLowerCase()
  const base = caseSensitive ? root : root.toLowerCase()
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return target.startsWith(prefix)
}

interface Identity {
  dev: bigint
  ino: bigint
}

function identity(path: string): Identity | undefined {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
    return stats === undefined ? undefined : { dev: stats.dev, ino: stats.ino }
  } catch {
    // ENOTDIR：路径里夹了一个普通文件。它不在任何目录之下，交给上层判否。
    return undefined
  }
}

function isIdentityUnder(path: string, root: string): boolean {
  const rootIdentity = identity(root)
  if (rootIdentity === undefined) return false
  let current = path
  for (;;) {
    const candidate = identity(current)
    if (candidate !== undefined
      && candidate.dev === rootIdentity.dev && candidate.ino === rootIdentity.ino) {
      return true
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** 与 `path.relative` 等价的目录包含判定，`root` 自身算包含。 */
export function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate))
  return relation === ''
    || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

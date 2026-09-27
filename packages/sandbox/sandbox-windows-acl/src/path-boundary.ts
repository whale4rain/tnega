/**
 * workspace 与私有 temp 两个目录能力之间的**目录边界**检查（都基于规范化路径）。
 *
 * 这两条断言存在的意义是：ACE 是继承的。私有 temp 落在 workspace 内，会让 workspace 的
 * 常驻能力顺着继承进入 temp；私有 temp 与可写目录重叠（任一方向），会让两个能力的边界
 * 合并成一个。任何一种都不是「更宽松一点」，而是白名单不再是它声称的那个集合。
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** `root` 与 `candidate` 是同一个规范目录，或 root 包含 candidate。 */
function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate))
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * 拒绝落在 workspace 内的 temp 父目录：它下面创建出来的每个子目录都会继承 workspace 的
 * 常驻能力。
 * @param workspaceRoot - 承载常驻 ACE 的 workspace 根（必须存在）。
 * @param tempRoot - 私有 temp 子目录将要在其中创建的父目录（必须存在）。
 */
export function assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void {
  if (containsDirectory(workspaceRoot, tempRoot)) {
    throw new Error(`windows-acl temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
  }
}

/**
 * 拒绝实际私有 temp 目录与任何可写目录重叠：任一继承方向都会把两个能力合并。
 * @param tempDir - 承载可撤销 temp 能力的现有目录。
 * @param writableDirs - 承载常驻 workspace 能力的目录。
 */
export function assertPrivateTempDisjoint(tempDir: string, writableDirs: readonly string[]): void {
  for (const writableDir of writableDirs) {
    if (containsDirectory(writableDir, tempDir) || containsDirectory(tempDir, writableDir)) {
      throw new Error(
        `windows-acl private temp directory must be disjoint from writable directories: writable=${writableDir}; temp=${tempDir}`,
      )
    }
  }
}

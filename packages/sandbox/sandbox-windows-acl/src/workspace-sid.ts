/**
 * 每个 workspace / 私有 temp 目录的写身份：从规范化路径确定性派生出的 `S-1-4-x-y` SID。
 *
 * 同一个 workspace 的每次受限执行——跨 session、跨进程重启、跨调用——都携带**同一个**
 * 写 SID，因此 workspace 根的 ACE 每台机器每个 workspace 只落一次（grant 的「完全一致
 * ACE」跳过让后续供给变成 O(1) 的读），而不是每个 session 落一次。SID 的权力完全由指向
 * 它的 ACE 定义（只存在于 workspace 树与该 session 的私有 temp 目录上），而只有为这个
 * workspace 铸造的令牌才携带它——SID 字符串本身不是秘密。
 *
 * temp 目录用 {@link tempWriteSid} 派生的独立身份：与 workspace 共用身份会让同一
 * workspace 上的兄弟 session 互相写对方的 temp 树。
 *
 * 入参**必须**是规范化的 workspace 路径（Windows 上即 `realpathSync.native` 的结果；
 * 沙箱策略的 `resolveWorkspaceRoot` 已经做过）。规范化会收敛大小写与别名拼写，于是同一
 * 目录的两种拼写派生同一个 SID；用未规范化的路径会为同一目录造出第二个身份（可自愈，
 * 代价是多一次全树传播）。重命名 workspace 目录会派生新 SID——旧的常驻 ACE 成为无害的
 * 残留，下一次供给会重新传播一次。
 */

import { createHash } from 'node:crypto'

/**
 * 派生 workspace 的写 SID（`S-1-4-x-y`，子授权号取 30 位，与令牌层、ACE 层的形状一致）。
 * @param workspaceRoot - 规范化后的 workspace 路径。
 * @returns SDDL 字符串形式。
 */
export function workspaceWriteSid(workspaceRoot: string): string {
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}`
}

/**
 * 派生一个私有 temp 目录的写 SID。
 *
 * 随机目录路径就是能力身份；固定的第三个子授权号把结果与所有两段式 workspace SID 在
 * 域上分开。
 * @param tempDir - 私有 temp 目录的绝对路径。
 * @returns SDDL 字符串形式。
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}-1`
}

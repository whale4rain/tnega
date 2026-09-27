import { writableRoots, type SandboxPolicy } from '@tnega/sandbox'

/**
 * 每个 runner 自己的 confinement 方言参数构造器。
 *
 * 这些是**纯函数**：没有状态、没有默认值、也不做平台判定 —— 「哪个 runner」是
 * Provider 的选择，profile 只回答「这个 runner 要什么参数」。返回值是
 * `--` 之前的全部参数，Provider 负责拼 `[...runnerArgv, ...profile, '--', ...argv]`。
 *
 * 三个 POSIX 后端对模式的解释完全一致：
 *
 * - `read-only`：整树只读，只留必需的写入 sink（`/dev/null`）。
 * - `workspace-write`：额外放开工作区，以及各自承诺的临时区（bwrap 用**临时 tmpfs**，
 *   landlock 用宿主真实 `/tmp`，seatbelt 用规范化后的 `/tmp` 与 `os.tmpdir()`）。
 */

/**
 * bubblewrap：把整棵树只读绑定进来，再按需把工作区 bind 成可写。
 *
 * `--unshare-pid` + `--proc /proc` 是安全项而不是洁癖：没有私有 PID namespace，
 * `/proc/1/root/...` 这类 procfs magic link 可以绕过 mount profile 写回宿主。
 * `--die-with-parent` 保证调用方崩溃时不留孤儿。
 *
 * 这里**没有** `--unshare-net`、`--clearenv`、`--chdir`：网络与进程可见性不在
 * sandbox 词汇内，环境与 cwd 由调用方的 spawn 决定。
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
  ]
  if (policy.mode === 'workspace-write') {
    // tmpfs 遮蔽宿主 /tmp：工作区内的进程拿到一个随进程消失的临时区，宿主的
    // /tmp 既不可见也不可写。
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Landlock launcher（`landlock-run` 之类的外部启动器）：`--ro / --rw ...` 是
 * allow-list，未授权一律拒绝，ruleset 跨 `execve` 继承到所有后代。
 *
 * 只授权 `/dev/null` **这一个文件**而不是整个 `/dev`：`/dev/shm` 是宿主上世界可写的
 * tmpfs，授权 `/dev` 等于放它进来。
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro', '/', '--rw', '/dev/null']
  if (policy.mode === 'workspace-write') {
    args.push('--rw', '/tmp')
    args.push('--rw', policy.workspaceRoot)
  }
  return args
}

function sbplString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * macOS Seatbelt：`allow default` 之后再掐掉一切 `file-write*`，只放行 `/dev/null`
 * 与可写根。
 *
 * 可写根必须来自共享的 {@link writableRoots}（已过 `realpathSync.native`），因为
 * Seatbelt 匹配的是**已解析路径**：darwin 上 `/tmp` 就是 `/private/tmp`。
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
  ]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    const subpaths = roots.map(root => `(subpath ${sbplString(root)})`).join(' ')
    forms.push(`(allow file-write* ${subpaths})`)
  }
  return ['-p', forms.join(' ')]
}

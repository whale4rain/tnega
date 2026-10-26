import { isNetworkRestricted, writableRoots, type SandboxPolicy } from '@tnega/sandbox'

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
 * 网络受限（`allowlist` / `off`）时加 `--unshare-net`：命令拿到一个只有回环的空网络。
 * `allowlist` 再把过滤代理的 Unix socket 所在目录只读绑定进来（它可能在被 tmpfs 遮住的
 * `/tmp` 下），由 {@link linuxRelayArgv} 在里面接回 TCP。
 *
 * 这里**没有** `--clearenv`、`--chdir`：环境与 cwd 由调用方的 spawn 决定。
 */
export function bwrapProfileArgs(policy: SandboxPolicy, proxySocketDir?: string): string[] {
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
  if (isNetworkRestricted(policy.network)) {
    args.push('--unshare-net')
    if (proxySocketDir !== undefined) args.push('--ro-bind', proxySocketDir, proxySocketDir)
  }
  return args
}

/** 受限命令在自己的网络里看到的代理端口（Linux 由 socat 中继，其它平台是代理的真实端口）。 */
export const LINUX_PROXY_PORT = 3128

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Linux 的网络中继：在 bwrap 的空网络里先起 socat，把 `localhost:3128` 接到绑定进来的
 * 代理 socket，等它开始监听，再运行命令，命令结束后收掉 socat 并镜像退出码。做法与
 * sandbox-runtime 相同（它多一个 SOCKS 端口；我们的代理在同一个口上说两种协议）。
 *
 * 先试 IPv6 双栈再退 IPv4：只监听 IPv4 会拒绝把 `localhost` 解析成 `::1` 的客户端，而没有
 * IPv6 的内核上双栈监听会立刻失败。等待按 `/proc/net/sockstat` 里本 namespace 的 TCP 计数，
 * 最多约三秒。
 *
 * @returns 放在 `--` 与调用方 argv 之间的前缀。
 */
export function linuxRelayArgv(socat: string, socketPath: string): string[] {
  const listen = 'fork,reuseaddr,backlog=4096'
  const target = `UNIX-CONNECT:${socketPath}`
  const relay = `${shellQuote(socat)} TCP6-LISTEN:${LINUX_PROXY_PORT},ipv6only=0,${listen} ${shellQuote(target)}`
    + ` || exec ${shellQuote(socat)} TCP4-LISTEN:${LINUX_PROXY_PORT},${listen} ${shellQuote(target)}`
  const script = [
    `{ ${relay}; } </dev/null >/dev/null 2>&1 &`,
    'tnega_relay=$!',
    'tnega_start=',
    'while kill -0 "$tnega_relay" 2>/dev/null; do',
    '  tnega_up=0',
    '  for tnega_file in /proc/net/sockstat /proc/net/sockstat6; do',
    '    [ -r "$tnega_file" ] || continue',
    '    while read -r tnega_kind tnega_skip tnega_inuse tnega_skip; do',
    '      case "$tnega_kind" in TCP:|TCP6:) tnega_up=$((tnega_up + tnega_inuse)); break ;; esac',
    '    done < "$tnega_file"',
    '  done',
    '  [ "$tnega_up" -lt 1 ] || break',
    '  read -r tnega_now tnega_skip < /proc/uptime || break',
    '  tnega_now=${tnega_now%.*}',
    '  [ "$((tnega_now - ${tnega_start:=$tnega_now}))" -lt 3 ] || break',
    'done',
    'unset tnega_start tnega_up tnega_file tnega_kind tnega_skip tnega_inuse tnega_now',
    '"$@"',
    'tnega_rc=$?',
    'kill "$tnega_relay" 2>/dev/null',
    'exit "$tnega_rc"',
  ].join('\n')
  return ['/bin/sh', '-c', script, 'tnega-sandbox-net']
}

/**
 * 让命令里的客户端找到过滤代理的环境变量。代理在同一个口上说 HTTP 与 SOCKS5，所以
 * `ALL_PROXY` 也给 `http://`（不少 Python 客户端见到 `socks5h://` 就要求额外的包）。
 * `NO_PROXY` 只留回环：受限命令没有直连，任何别的地址都得经代理。
 *
 * `GIT_SSH_COMMAND` 让 `git` 的 ssh 也走代理（POSIX 才有：Linux 用 socat 的 `PROXY:`，macOS 用
 * 自带 nc 的 HTTP CONNECT）；Windows 的 MXC 只认 HTTP/S 代理，ssh 在那里连不出去。
 */
export function proxyEnvironment(port: number, platform: NodeJS.Platform, socat = 'socat'): Record<string, string> {
  const url = `http://127.0.0.1:${port}`
  const env: Record<string, string> = {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, GRPC_PROXY: url,
    http_proxy: url, https_proxy: url, all_proxy: url, grpc_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    // Node 24+ 的内置 fetch 只在这个开关下读代理变量。
    NODE_USE_ENV_PROXY: '1',
  }
  const ssh = 'ssh -o ControlMaster=no -o ControlPath=none'
  if (platform === 'linux') {
    env.GIT_SSH_COMMAND = `${ssh} -o ProxyCommand=${shellQuote(`${socat} - PROXY:127.0.0.1:%h:%p,proxyport=${port}`)}`
  } else if (platform === 'darwin') {
    env.GIT_SSH_COMMAND = `${ssh} -o ProxyCommand=${shellQuote(`nc -X connect -x 127.0.0.1:${port} %h %p`)}`
  }
  return env
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
 * 与可写根。网络受限时再掐掉一切 `network*`（含 Unix socket，因此 Docker 之类的本地 socket
 * 也连不上），`allowlist` 只放行到过滤代理端口的连接。Seatbelt 后写的规则优先。
 *
 * 可写根必须来自共享的 {@link writableRoots}（已过 `realpathSync.native`），因为
 * Seatbelt 匹配的是**已解析路径**：darwin 上 `/tmp` 就是 `/private/tmp`。
 */
export function seatbeltProfileArgs(policy: SandboxPolicy, proxyPort?: number): string[] {
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
  if (isNetworkRestricted(policy.network)) {
    forms.push('(deny network*)')
    if (proxyPort !== undefined) forms.push(`(allow network-outbound (remote ip "localhost:${proxyPort}"))`)
  }
  return ['-p', forms.join(' ')]
}

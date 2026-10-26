# `@tnega/sandbox-local`

`ctx.sandbox` 的本机 Provider：把调用方的 argv 包成某个真实机制下的受限 argv，或者
fail closed。

Electron 宿主使用自身可执行文件启动 Windows runner（MXC 与 ACL 两个都是）时，探测和执行都仅给 runner
设置 `ELECTRON_RUN_AS_NODE=1`；runner 启动受限目标前删除该变量，避免改变目标程序的启动模式。
`ConfinedArgv.env` 由 Consumer 透传到执行边界，不修改宿主环境。

## 平台链与功能性探测

| 平台 | 链（按序） | 机制 |
|---|---|---|
| linux | `bwrap` → `landlock` | mount profile / Landlock launcher |
| darwin | `seatbelt` | `sandbox-exec -p <profile>` |
| win32 | `windows-mxc` → `windows-acl` | Microsoft eXecution Container（`@tnega/sandbox-windows-mxc`）/ 受限令牌 + capability SID 写白名单（`@tnega/sandbox-windows-acl`） |

链上第一个**功能性探测**通过的机制被选中：

- bwrap：真的跑一次只读 profile 下的 `true`（`--version` 不能证明 user namespace 可用）；
- landlock：跑 `<launcher> --probe`，按它报告的 ABI 给出 `full` 或 `partial`；
- seatbelt：真的跑一次 `sandbox-exec -p <read-only profile> -- true`；
- windows-mxc：先找到 MXC 执行器 `wxc-exec.exe`（`mxcExecPath` → `TNEGA_MXC_EXEC` →
  `@microsoft/mxc-sdk` 载荷 → 全局 npm 前缀 → `PATH`），再经 runner 在 MXC 里真的跑一次
  只读的 `exit 0`；请求契约按 `1.0.0` → `0.9.0-alpha` 依次试，第一个跑通的被记住
  （`mxcContractVersion` 可固定）。找不到执行器、系统低于 MXC 的版本下限、执行器拒绝请求，
  都让探测失败并退到 windows-acl。`TNEGA_MXC_EXEC=off` 直接跳过 MXC；
- windows-acl：先确认 FFI 可加载，再真的跑一次 runner 的只读空命令。

判决（含「不可用」）按 Provider 生命周期缓存 —— 探测要起进程，而机制不会在一次运行中间
出现或消失；装卸/修复 runner 需要重新挂载插件。链耗尽 → `SandboxUnavailableError`。

## 各机制的 argv 契约

```
bwrap     : bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
                   [--tmpfs /tmp --bind <workspace> <workspace>] -- <argv...>
landlock  : <launcher> --ro / --rw /dev/null [--rw /tmp --rw <workspace>] -- <argv...>
seatbelt  : sandbox-exec -p '<profile>' -- <argv...>
windows-mxc: <node> <runner> --workspace <dir> --mode <mode> --exec <wxc-exec> --contract <ver>
                   --container-id <id> [--temp <dir>] [--read-only-root <dir>]... -- <argv...>
windows-acl: <node> <runner> --workspace <dir> --temp <dir> --mode <mode>
                   [--write-sid <S> --temp-write-sid <S>] -- <argv...>
custom    : <runnerCommand...> --mode <mode> --workspace <dir> --temp <dir> -- <argv...>
```

网络受限时（策略的 `network` 是 `allowlist` 或 `off`）：

```
bwrap     : ... --unshare-net [--ro-bind <proxy-dir> <proxy-dir>] -- [/bin/sh -c <socat 中继> tnega-sandbox-net] <argv...>
seatbelt  : profile 追加 (deny network*) [(allow network-outbound (remote ip "localhost:<proxy-port>"))]
windows-mxc: ... --network off | --network http://127.0.0.1:<proxy-port> ...
```

`allowlist` 时 Provider 为每份网络策略起一个 `@tnega/sandbox-network-proxy` 过滤代理（Linux 监听
私有 0700 目录里的 Unix socket，其它平台监听 `127.0.0.1` 的随机端口，dispose 时关闭），并给命令
`HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY` 等环境变量。放行的连接经 `upstreamProxy`（省略时是宿主的
`HTTPS_PROXY` / `HTTP_PROXY`）出去。命令退出后，`annotate` 列出本次被拒的主机。

网络能力另做一次探测并缓存：bwrap 要真能建 network namespace，`allowlist` 还要 `socat -V` 成功；
MXC 的 `allowlist` 要这台 Windows 真的接受代理模式（在 MXC 里跑一次带代理的 `exit 0`）；
landlock、windows-acl、custom 管不了网络。做不到时 `confine` 抛 `SANDBOX_UNAVAILABLE` 并说明原因，
`status().network` 给出同样的结论（设置界面经 `GET /api/sandbox/network` 读它）。

`--unshare-pid` + `--proc /proc` 是安全项：没有私有 PID namespace，`/proc/1/root/...`
这类 procfs magic link 可以绕过 mount profile 写回宿主。landlock 只授权 `/dev/null`
这一个文件而不是 `/dev`，否则 `/dev/shm` 这种世界可写的宿主 tmpfs 就进来了。

## 配置

```ts
await ctx.plugin(sandboxLocal, {
  workspaceRoot: canonicalPath(cwd),   // 探测与无 Session 调用的根
  tempRoot: undefined,                 // 私有临时区的父目录，默认 os.tmpdir()
  probeTimeoutMs: 5_000,               // 必须为正有限值（0 在 Node 里表示「无超时」）
  bwrapPath / landlockLauncher / sandboxExecPath,
  windowsAclRunnerCommand,
  windowsMxcRunnerCommand,
  mxcExecPath,                         // 省略：TNEGA_MXC_EXEC → @microsoft/mxc-sdk → 全局 npm 前缀 → PATH
  mxcContractVersion,                  // 省略：探测协商
  mxcRead: 'all',                    // 默认：每个卷根都只读 → 读不受限（与 ACL 链一致）
  mxcReadOnlyRoots,                    // 叠加的读根；mxcRead: 'roots' 时是唯一来源
  runnerCommand / runnerFailureSignatures / runnerDenialSignatures,  // custom
  socatPath,                           // Linux 网络过滤的 socat，默认按 PATH 找
  upstreamProxy: () => undefined,      // 放行后的上游代理；undefined 退回 HTTPS_PROXY，'' 直连
  noProxy: () => process.env.NO_PROXY, // 不走上游的目标
  internals: { platform, chain, probe, networkProbe },  // 测试/覆盖用
})
```

## Windows 的授权生命周期

**MXC**：Provider 不落任何 ACE。runner 为每次调用写一份 MXC 请求，MXC 自己落策略并在请求
结束时撤销（`preservePolicy: false`）；`workspace-write` 的私有 temp 由 runner 按次创建、
按次删除。

**ACL**：Provider 负责 ACL，runner 负责令牌：

- **workspace 的 standing ACE 常驻**，作为跨 Session 的复用缓存（撤销它要重做整树传播，
  而它是一个只有本 Provider 会命名的随机 SID）；
- **私有 temp 每个 (session, workspace) 一个**，ACE 可撤销，`dispose` 时撤销并删除目录；
- 清理失败只记日志，不打断 cordis teardown；`tempRoot` 落在工作区内直接拒绝。

## 已知限制

- 限制**文件写**，以及配置了时的**命令网络**。进程可见性不在词汇内。
- 网络过滤只对遵守代理环境变量的客户端有效（其它连接在空网络里直接失败）；按域名放行不看 TLS
  内容。Windows MXC 只认 HTTP/S 代理，ssh 等其它协议在 `allowlist` 下连不出去。
- Windows MXC 的读侧默认放开（`mxcRead: 'all'`：每个卷根都是只读根），因为 AppContainer
  档位没有环境读权限，而 `node` / `npm` / `pwsh` 装在工作区之外的哪个盘只取决于用户环境；
  这也与 ACL 链「只收窄写」的既有语义一致。需要读侧隔离的部署用 `mxcRead: 'roots'`。
- Windows ACL 是 `partial`：Everyone 仍在环境权限里，NTFS 硬链接是文件对象别名。
- Windows MXC 也是 `partial`：硬链接同样是别名，选中的档位随宿主而变（新系统上的
  base-container 档保留环境读权限）。详见 `@tnega/sandbox-windows-mxc` 的 README。
- Seatbelt 依赖 Apple 已弃用但仍随系统发布的 `sandbox-exec`；一旦移除，darwin 会在执行期
  fail closed。
- 探测不是安全边界：它只回答「这个机制现在能不能跑起来」。

## 测试

`test/local.test.ts` 逐字钉死四种 runner 的 argv、链式回退、探测缓存、无链时的
`SANDBOX_UNAVAILABLE`/`status()`、tempRoot 越界与配置校验。真实机制（bwrap/landlock/
seatbelt）的端到端验证需要在有对应二进制与内核支持的机器上跑，仓库内的测试不假设宿主
一定具备它们。`packages/sandbox/sandbox-windows-mxc/test/locate.test.ts` 钉死执行器的
查找顺序（含全局 npm 前缀）。

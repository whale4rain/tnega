# `@tnega/sandbox-local`

`ctx.sandbox` 的本机 Provider：把调用方的 argv 包成某个真实机制下的受限 argv，或者
fail closed。

Electron 宿主使用自身可执行文件启动 Windows ACL runner 时，探测和执行都仅给 runner
设置 `ELECTRON_RUN_AS_NODE=1`；runner 启动受限目标前删除该变量，避免改变目标程序的启动模式。
`ConfinedArgv.env` 由 Consumer 透传到执行边界，不修改宿主环境。

## 平台链与功能性探测

| 平台 | 链（按序） | 机制 |
|---|---|---|
| linux | `bwrap` → `landlock` | mount profile / Landlock launcher |
| darwin | `seatbelt` | `sandbox-exec -p <profile>` |
| win32 | `windows-acl` | 受限令牌 + capability SID 写白名单（`@tnega/sandbox-windows-acl`） |

链上第一个**功能性探测**通过的机制被选中：

- bwrap：真的跑一次只读 profile 下的 `true`（`--version` 不能证明 user namespace 可用）；
- landlock：跑 `<launcher> --probe`，按它报告的 ABI 给出 `full` 或 `partial`；
- seatbelt：真的跑一次 `sandbox-exec -p <read-only profile> -- true`；
- windows-acl：先确认 FFI 可加载，再真的跑一次 runner 的只读空命令。

判决（含「不可用」）按 Provider 生命周期缓存 —— 探测要起进程，而机制不会在一次运行中间
出现或消失；装卸/修复 runner 需要重新挂载插件。链耗尽 → `SandboxUnavailableError`。

## 各机制的 argv 契约

```
bwrap     : bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
                   [--tmpfs /tmp --bind <workspace> <workspace>] -- <argv...>
landlock  : <launcher> --ro / --rw /dev/null [--rw /tmp --rw <workspace>] -- <argv...>
seatbelt  : sandbox-exec -p '<profile>' -- <argv...>
windows   : <node> <runner> --workspace <dir> --temp <dir> --mode <mode>
                   [--write-sid <S> --temp-write-sid <S>] -- <argv...>
custom    : <runnerCommand...> --mode <mode> --workspace <dir> --temp <dir> -- <argv...>
```

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
  runnerCommand / runnerFailureSignatures / runnerDenialSignatures,  // custom
  internals: { platform, chain, probe },  // 测试/覆盖用
})
```

## Windows 的授权生命周期

Provider 负责 ACL，runner 负责令牌：

- **workspace 的 standing ACE 常驻**，作为跨 Session 的复用缓存（撤销它要重做整树传播，
  而它是一个只有本 Provider 会命名的随机 SID）；
- **私有 temp 每个 (session, workspace) 一个**，ACE 可撤销，`dispose` 时撤销并删除目录；
- 清理失败只记日志，不打断 cordis teardown；`tempRoot` 落在工作区内直接拒绝。

## 已知限制

- 只限制**文件写**。网络与进程可见性不在词汇内，也没有后端试图限制它们。
- Windows ACL 是 `partial`：Everyone 仍在环境权限里，NTFS 硬链接是文件对象别名。
- Seatbelt 依赖 Apple 已弃用但仍随系统发布的 `sandbox-exec`；一旦移除，darwin 会在执行期
  fail closed。
- 探测不是安全边界：它只回答「这个机制现在能不能跑起来」。

## 测试

`test/local.test.ts` 逐字钉死四种 runner 的 argv、链式回退、探测缓存、无链时的
`SANDBOX_UNAVAILABLE`/`status()`、tempRoot 越界与配置校验。真实机制（bwrap/landlock/
seatbelt）的端到端验证需要在有对应二进制与内核支持的机器上跑，仓库内的测试不假设宿主
一定具备它们。

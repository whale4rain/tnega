# `@tnega/execution`

本机执行边界：shell 命令、无 shell 的 argv 进程，以及 HTTP 抓取。

## 这不是一条缝

本包是**纯库，没有 ctx key**，按 dsh 的措辞属于「library — no ctx key」那一类，不叫
Service Definition，也不构成能力缝。它导出的是词汇（`ShellRequest` / `ProcessRequest` /
`HttpRequest` 与对应结果类型）、`ExecutionProvider` 契约，以及一份本机实现
`localExecutionProvider`。

它当前通过 `BuiltinToolsConfig.execution` 以配置方式传给消费者（`shell` / `http_get` /
`glob` / `grep` 的旧路径），而不是通过 `ctx.<key>` 注入。把它提升成真正的进程缝
（抽象 `Service` + `ctx.execution` + 独立的 provider 包）是后续工作；本包的存在就是为了
让那一步是「在本包上加一个抽象 Service」，而不是再一次搬家。

## 为什么单独成包

`@tnega/search-ripgrep` 必须把 ripgrep 落到进程上。若让它自带 spawn，仓库里就会出现第二
条执行边界，Windows 下的进程树终止（`taskkill /t /f`）这类逻辑会有两份并必然漂移。把执行
边界收在本包，`@tnega/tools` 与 `@tnega/search-ripgrep` 共用同一份实现。

`@tnega/tools` 仍然 re-export 本包，所以 `@tnega/tools` 的公共面没有变化。

## 语义

- `runShell` 走 shell（`shell: true`）；`runProcess` 是纯 argv 向量（`shell: false`），
  模型可控的值永远是独立参数，中间没有引号层。
- 进程的 stdin 一律指向 `/dev/null`：本仓库没有地方会写子进程的 stdin，而一个打开的
  stdin 管道会让读 stdin 的程序（例如没有显式路径的 ripgrep）永远等下去。
- 超时与调用方中断都会终止整棵进程树，并以 reject 结束；子进程自身的退出码则以结果返回。
- `stdoutTruncated` 标记这一次捕获是否被 `maxBuffer` 截断，调用方必须据此拒绝解析，
  而不是把半截输出当成完整结果。

# `@tnega/process-local`

`ctx.process` 的本机 **Provider**（Service Definition 见 `@tnega/process`）：shell 命令、无 shell 的
argv 进程，以及 HTTP 抓取，都在这台电脑上执行。原来的 `@tnega/execution` 搬到这里；
`@tnega/execution` 只剩一层带 `@deprecated` 的转发，保留一个版本。

- `localExecutionProvider`：未装饰的本机边界。composition 层（`packages/runtime` 的
  `capability:sandbox`）用 secrets 与 sandbox 装饰器包好它，再以 `processBoundary` 提供
  `ctx.process`，所以带沙箱的作用域拿不到未装饰的边界。
- `processLocal` 插件：直接提供未装饰的本机边界，只给没有沙箱的场景与测试用。
- 机器侧的配置（`configureSystemShell`、`configureProcessLauncher`、`configureNetwork`）
  也在这里，由宿主进程调用。

## 为什么单独成包

`@tnega/search-ripgrep` 必须把 ripgrep 落到进程上。若让它自带 spawn，仓库里就会出现第二
条执行边界，Windows 下的进程树终止（`taskkill /t /f`）这类逻辑会有两份并必然漂移。把执行
边界收在本包，`@tnega/tools` 与 `@tnega/search-ripgrep` 共用同一份实现。

`@tnega/tools` 仍然 re-export `@tnega/process` 与本包，所以 `@tnega/tools` 的公共面没有变化。

## 语义

- `runProcess` / `startProcess` 的 `env` 是仅对子进程生效的环境覆盖，合并宿主环境；
  不修改宿主进程。沙箱 Consumer 同时传递 Provider 的 runner 环境要求。
- `runShell` 直接启动系统 shell（`systemShell()`：Windows 上依次是 PowerShell 7、
  Windows PowerShell、Git Bash、cmd；其他平台是 `$SHELL`；`TNEGA_SHELL` 可覆盖），命令作为
  单个参数传入（PowerShell 用 `-EncodedCommand`），不经过 `cmd.exe`；`runProcess` 是纯 argv
  向量（`shell: false`），模型可控的值永远是独立参数，中间没有引号层。
- Windows 上 `taskkill /t` 之后再按 `ParentProcessId` 清理 shell 当时正在创建的孤儿子进程。
- 进程的 stdin 一律指向 `/dev/null`：本仓库没有地方会写子进程的 stdin，而一个打开的
  stdin 管道会让读 stdin 的程序（例如没有显式路径的 ripgrep）永远等下去。
- 超时与调用方中断都会终止整棵进程树，并以 reject 结束；子进程自身的退出码则以结果返回。
- `stdoutTruncated` 标记这一次捕获是否被 `maxBuffer` 截断，调用方必须据此拒绝解析，
  而不是把半截输出当成完整结果。

## 宿主启动方式

`configureProcessLauncher(launcher)` 为整个宿主进程安装可选的 argv 启动方式；返回的清理函数
可重复调用，且重叠安装按任意顺序清理不会重新启用已经清理的 launcher。最近安装的 launcher
返回 `undefined` 时使用原本的 Node `spawn`。命令捕获、输出上限、取消、超时与进程树终止仍由
本包统一处理；后台进程的 `pid` 在宿主异步创建进程后可用。

Windows 桌面仅将沙箱 Provider 标记的内置 ACL runner 交给 Electron `utilityProcess`；其
原生启动器关闭系统的启动游标反馈，避免每次 shell/search 工具调用都让鼠标转圈。普通命令、
Web/CLI 宿主与自定义 runner 保持原本启动方式。桌面退出时撤销这个宿主入口。

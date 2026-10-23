# `@tnega/sandbox-windows-mxc`

tnega 沙箱能力缝的第二个 Windows 机制库：把受限命令交给 Microsoft eXecution Container
（MXC）的 ProcessContainer 后端，由 MXC 落文件策略、启动并收容命令，runner 镜像退出码。

它和 `@tnega/sandbox-windows-acl` 一样是**机制库**，不是缝的角色。`@tnega/sandbox-local`
把它放在 Windows 链的第一位：

```
win32: windows-mxc → windows-acl
```

功能性探测通过就用 MXC；宿主上找不到执行器、系统低于 MXC 的版本下限（Windows 11 24H2，
build 26100）、或执行器拒绝请求时，探测失败，退到原有的 ACL 受限令牌。两者都不可用才是
`SANDBOX_UNAVAILABLE`，绝不以非受限方式执行。

## 为什么要它

ACL 机制要在工作区树上落一条常驻的可继承 ACE（大仓库首次传播要几分钟，文件夹归属别的账户时
直接失败），受限进程里用 libuv 命名管道起孙进程会 EPERM。MXC 由 Microsoft 维护、由策略驱动：
档位选择、ACL 的落与撤销、拒绝记录都在 MXC 里，tnega 只描述「这次调用可以写哪里」。参考实现
`whale4rain/dsh-sandbox-windows-mxc` 在 Windows 11 25H2（base-container 档）上验收过：工作区内
写入放行、工作区外写入被拒且不产生文件、带管道 stdio 的 Node 孙进程正常工作。

## 执行器从哪里来

按顺序：

1. `sandbox-local` 的 `mxcExecPath` 配置；
2. 环境变量 `TNEGA_MXC_EXEC`（设为 `off` 则跳过 MXC，直接用 windows-acl）；
3. 可解析到的 `@microsoft/mxc-sdk` 包里的 `bin/<arch>/wxc-exec.exe`（x64 / arm64 互为回退）；
4. 全局安装的 SDK（`<npm prefix>/node_modules/@microsoft/mxc-sdk`）：前缀依次取
   `NPM_CONFIG_PREFIX` / `npm_config_prefix`、`%APPDATA%\npm`（Windows 默认值），以及
   `PATH` 上每个目录与它父目录旁边的 `node_modules`；
5. `PATH` 上的 `wxc-exec.exe`。

第 4 条读的是**真实的 npm 前缀**，不是只认默认值：`~/.npmrc` 里的 `prefix=` 能把全局根指到
别的盘，`npm install -g` 装的包就落在那里，只查 `%APPDATA%\npm` 会永远报 `missing`。这里不跑
`npm config get prefix` 子进程 —— 前缀的 `xxx.cmd` 本来就在 `PATH` 上，兄弟 `node_modules`
是同步判一下就够的事实。

tnega **不**自带执行器：SDK 解包约 108 MB（含全部平台的原生载荷）。在 Windows 上
`npm install -g @microsoft/mxc-sdk` 再重启 tnega 即可启用。

`mxcSetup()` 不起进程地报告本机状态（`unsupported` / `disabled` / `missing` / `installed`）。
`@tnega/sandbox-local` 的 `sandboxSetupRoutes` 以 `GET /api/sandbox/setup` 提供它；Windows 24H2+
上找不到执行器时，Web 与桌面端在对话顶部显示一条可关闭的安装提示（`components/MxcHint.tsx`，
关闭状态按设备记在 `tnega.mxcHint`）。

## 一次调用如何变成 MXC 请求

Provider 拼出 runner argv（见 `src/runner.ts` 的契约），runner 为这一次调用写请求：

| 请求字段 | read-only | workspace-write |
|---|---|---|
| `filesystem.readwritePaths` | `[]` | `[工作区, 本次的私有 temp]` |
| `filesystem.readonlyPaths` | `[工作区, ...mxcReadOnlyRoots]` | `[...mxcReadOnlyRoots]` |
| `process.commandLine` | cmd 的 `/c` 之后原样包进引号，其余程序按 CRT 规则加引号 | 同左 |
| `process.cwd` / `process.env` | 命令的工作目录 / 执行层组装的环境（去掉 runner 专属变量） | 同左，TMP/TEMP 指向私有 temp |
| `network` | 两个方向显式 `allow`（本缝只管文件；省略在 MXC 里等于拒绝） | 同左 |
| `ui` | `{ disable: false, clipboard: 'none', injection: false }` | 同左 |
| `lifecycle` | `{ destroyOnExit: true, preservePolicy: false }` | 同左 |
| `containerId` | `tnega-<sha256(工作区, Session)[0..24]>` | 同左 |
| `version` | 探测协商出的契约（`1.0.0` 或 `0.9.0-alpha`） | 同左 |

- `ui.disable: false` 是参考实现在真机上找到的：MXC 默认禁 Win32k，PowerShell 与 Node 会以
  `STATUS_DLL_INIT_FAILED`（0xC0000142）在启动时死掉。
- 不设执行超时：命令期限属于执行层。
- 请求里带着子进程的完整环境，所以请求文件只在本次调用期间存在于私有目录里，结束即删。

## 失败

| 结果 | 表现 |
|---|---|
| 命令跑了，写被拒 | 本后端的拒绝方言（`Access is denied` / 「拒绝访问」 / `Access to the path` / `EPERM`） |
| 命令跑了，自己失败 | 普通的非零退出码 |
| 沙箱没把命令跑起来 | runner 在 stderr 写 `mxc-sandbox-run: <原因>` 并以 127 退出 → `SANDBOX_UNAVAILABLE` |

MXC 的拒绝有两种形状，runner 都转成上面第三行：stderr 最后一行的 JSON 错误信封（已知错误码），
以及执行前的纯文本请求错误（例如契约版本不受支持）。命令自己打印的 JSON 不在最后一行、或错误码
未知，都不会被误判。

## 与参考实现的差异

- **cmd 命令行**：参考实现对所有程序都用 CRT 引号规则，`cmd /s /c` 后面的命令会被转义成
  `\"`，带引号或重定向的命令会被改写。这里与 windows-acl runner 同一规则。
- **契约协商**：参考实现只说一个固定契约，执行器不支持时需要手动改配置；这里由探测依次试。
- **探测**：参考实现用 `--dry-run` 只验证请求能否解析；这里真的在 MXC 里跑一次只读命令，
  同时证明宿主档位可用。
- **桌面端**：runner 以 Electron utility process 承载时，显式 `process.exit`（只设
  `exitCode` 不会结束 utility process）。
- 去掉了本缝用不到的配置面（网络拒绝、UI 拒绝、拒绝报告、ETL 等）。

## 已知限制

- `enforcement` 永远是 `partial`：NTFS 硬链接是文件对象别名；选中的档位随宿主而变，
  base-container 档保留调用者的环境读权限。
- AppContainer 档位没有环境读权限：工作区之外命令要读的工具链目录需要列进 `mxcReadOnlyRoots`；
  这些档位还需要 MXC 按次在工作区上落 ACE 并在结束时撤销，大工作区上每次调用都有这份开销。
  参考实现验收的 base-container 档不需要 DACL 改写（`needsDaclAugmentation: false`）。
- 拒绝方言里的中文文案只在子进程输出按 UTF-8 解码正确时才能匹配；OEM 代码页的输出会被误解码
  （与 windows-acl 相同的已知限制）。
- 真机验证只能在 Windows 24H2+ 上做：本仓库的测试用假执行器钉住 runner 与 Provider 的全部
  契约，真 MXC 的验收属于发布前的手动步骤（见 `docs/publish/README.md`）。

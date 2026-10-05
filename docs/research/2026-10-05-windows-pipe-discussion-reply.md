# Windows 沙箱 stdio 与子进程管道：实现补充和路线讨论

感谢你的详细回复，尤其是区分 **Win32 命名管道的默认安全描述符**与 **token default DACL**。我整理了当前实现与一组实测，想进一步确认三条路线能覆盖到哪一层，以及是否能兼容未修改的 Vite/esbuild。

背景讨论：[Discussion #8866 的回复](https://github.com/deepseek-ai/deepseek-harness/discussions/8866#discussioncomment-18752851)。以下代码链接固定到 Tnega 的提交 `2edf41f`，避免后续源码移动导致描述不一致。

## 1. 我们的实现：宿主捕获输出，runner 继承句柄

这里需要先纠正一个容易混淆的表述：Tnega **不是在所有 Node `spawn()` 调用上设置 `stdio: 'inherit'`**。继承发生在 runner 调用 Win32 API 启动受限命令时。

### 1.1 沙箱外：Node 创建用于日志采集的管道

[`packages/execution/src/index.ts`](https://github.com/whale4rain/tnega/blob/2edf41fbafa34ce40b4ba47f8c47c32e4399aa1f/packages/execution/src/index.ts#L307-L323) 的实际配置是：

```ts
function spawnOptions(
  cwd: string,
  stdin: 'ignore' | 'pipe',
): Parameters<typeof spawn>[2] {
  return {
    cwd,
    windowsHide: true,
    stdio: [stdin, 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? {} : { detached: true }),
  }
}
```

普通命令与后台进程都使用这一层收集输出。在受限执行路径中，宿主启动的是 runner；这些管道由尚未受限的宿主创建，stdout/stderr 用来形成工具结果和后台进程日志。

### 1.2 执行包装：先取得受限 argv，再启动 runner

[`execution-sandbox/src/index.ts`](https://github.com/whale4rain/tnega/blob/2edf41fbafa34ce40b4ba47f8c47c32e4399aa1f/packages/sandbox/execution-sandbox/src/index.ts#L131-L147) 中的关键路径如下：

```ts
const confined = await confine(
  'shell', shellArgv(request, config), request, activePolicy,
)
const result = await inner.runProcess({
  ...confined,
  cwd: request.cwd,
  // 此处省略 timeout、buffer、signal 的原样传递。
})
```

这是节选，省略处只是执行限制参数，不改变 stdio 的设置。`confine` 返回沙箱包装后的 argv，Windows 路径由 runner 创建受限令牌并启动目标命令。

### 1.3 沙箱内入口：通过 Win32 API 继承已有句柄

[`runner.ts` 的 `spawnRestrictedInherited`](https://github.com/whale4rain/tnega/blob/2edf41fbafa34ce40b4ba47f8c47c32e4399aa1f/packages/sandbox/sandbox-windows-acl/src/runner.ts#L1058-L1100) 会先把 runner 自己的标准句柄标记为可继承：

```ts
const stdio = inheritedStandardHandles(api)
for (const [handle, label] of [
  [stdio.stdin, 'stdin'],
  [stdio.stdout, 'stdout'],
  [stdio.stderr, 'stderr'],
] as const) {
  if (api.setHandleInformation(
    handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT,
  ) === 0) {
    throwLastError(api, 'SetHandleInformation', `${label} (enable inherit)`)
  }
  enabled.push(handle)
}
```

随后设置 `STARTF_USESTDHANDLES`，并向受限子进程传入已有句柄：

```ts
api.encodeStartupInfo(startupInfo, {
  cb: STARTUPINFOW_SIZE,
  dwFlags: STARTF_USESTDHANDLES,
  hStdInput: stdio.stdin,
  hStdOutput: stdio.stdout,
  hStdError: stdio.stderr,
})

const created = api.createProcessAsUserW(
  token,
  null,
  buildCommandLine(options.command, options.args),
  null,
  null,
  1, // bInheritHandles = TRUE
  CREATE_SUSPENDED | CREATE_NO_WINDOW,
  null,
  options.cwd,
  startupInfo,
  processInfo,
)
```

受限命令先以 suspended 状态创建，再加入带 `KILL_ON_JOB_CLOSE` 的 Job Object，最后恢复执行；失败路径会终止并清理子进程。

实际链路是：

```text
未受限宿主
  └─ 创建 stdout/stderr 捕获管道，启动 runner
       └─ runner 创建受限令牌，继承已有标准句柄启动 shell
            └─ npm / Vite / Node 程序
                 └─ 程序自己用 stdio:'pipe' 启动子进程
                      ↑ 当前失败出现在这一层
```

因此，我们理解 runner 这一层与 DSH 的 inherited stdio 思路一致；尚未解决的是第三方程序在受限进程内部重新创建管道。

### 1.4 受限令牌与 default DACL

[`runner.ts` 的令牌创建路径](https://github.com/whale4rain/tnega/blob/2edf41fbafa34ce40b4ba47f8c47c32e4399aa1f/packages/sandbox/sandbox-windows-acl/src/runner.ts#L970-L985) 使用：

```ts
const restricting = options.mode === 'read-only'
  ? [logonSid, worldSid]
  : [logonSid, worldSid, ...writeSids]

const created = api.createRestrictedToken(
  currentToken,
  DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
  0, null,
  0, null,
  restricting.length,
  packRestrictingSids(api, restricting),
  tokenSlot,
)

// 创建成功并取出 token 后：
setTokenDefaultDaclGrant(api, token, writeSids.at(-1) ?? worldSid)
```

Workspace 和私有临时目录通过对应能力 SID 与 ACL 授予写入范围，logon SID 与 Everyone 保留在 restricting 列表中。我们没有用加入当前用户 SID 的办法绕过检查，因为那会扩大文件写入权限。

## 2. 当前实测：继承成功，内部 pipe 失败

2026-10-05，我通过当前构建的真实 Windows runner，在 `workspace-write` 下执行了下面的 Node 探针。两次只改变 `stdio`：

```js
const { spawnSync } = require('node:child_process')
const r = spawnSync(
  process.execPath,
  ['-e', 'console.log("child-ok")'],
  { stdio: 'inherit' }, // 对照组改为 'pipe'
)
console.log(JSON.stringify({ status: r.status, error: r.error?.code }))
```

结果：

| 受限 Node 内的子进程配置 | 输出 / 状态 |
| --- | --- |
| `stdio: 'inherit'` | 捕获到 `child-ok`，`status: 0` |
| `stdio: 'pipe'` | `status: null`，`error: 'EPERM'` |

这组实验确认了失败与内部 pipe 创建相关，但没有单凭 Node 错误码定位到具体哪个 Win32 调用或访问掩码。因此我们把命名管道安全描述符的解释作为与 DSH 文档一致的机制判断，仍与逐 API 调试证据区分开。

另一个细节是：探针捕获错误并打印后，外层 Node 自身可以退出 0；所以判断失败不能只看最外层命令的退出码。

## 3. 你提出的三条路线，我们目前如何考虑

### 路线一：创建命名管道时显式授予 restricting SID

你的建议是，在管道安全描述符中显式加入需要的 ACE，而不是继续修改 token default DACL。

**吸引力：** 如果能覆盖沙箱内 libuv 的创建及连接流程，有机会保留第三方程序原本的 `child.stdin` / `child.stdout` 流接口，也无需把协议通信改成日志采集。

**当前疑问：** 我们可以控制 runner，但 Vite/esbuild 内部调用的是其 Node 进程自己的 libuv。只修改 runner 创建的管道并不能覆盖它们。可能需要定制 Node/libuv、原生调用拦截，或其他能覆盖内部创建路径的机制；我们尚未验证这些方案。

还需要检查权限是否只作用于本次需要的 IPC 对象，以及创建端和连接端的检查是否都能通过。不会以扩大整个 token 的文件写权限来换取兼容性。

**倾向：** 作为保留现有通信语义的候选方案值得做最小实验，但暂不把它当成低成本修复。

### 路线二：Node 子进程使用 `inherit` / `ignore`，配合文件采集

**适用场景：** 我们控制的子进程只需执行命令、显示或记录日志，父进程不依赖它的 stdout 返回值或 stdin 通信。

`inherit` 能复用外层已经建立的句柄，不必丢失所有日志。我们刚才的探针就是子进程继承输出，最终仍由宿主捕获。需要独立日志时，也可以把 stdout/stderr 指向 Workspace / 私有临时目录内已打开的文件，再由宿主持续读取。Node 支持将已打开的文件描述符传入 `stdio`：[官方说明](https://nodejs.org/download/release/v25.9.0/docs/api/child_process.html#optionsstdio)。

**不能直接替换的场景：** esbuild 的 JS API 与 Go 子进程通过 stdin/stdout 交换二进制协议，这不是普通日志。全局把 `spawn` 改为 `inherit` / `ignore` 会失去专用通信流；单纯把输出写文件也没有保留原来的双向协议。[esbuild 协议源码](https://github.com/evanw/esbuild/blob/main/lib/shared/stdio_protocol.ts)

用 `NODE_OPTIONS` 预加载模块修改 `child_process` 可以作为局部实验，但不能预先假定它覆盖所有 Node、原生或非 Node 子进程，更不能假定改写后第三方 API 仍兼容。

**倾向：** 用于我们控制的日志型命令；不把它作为强制替换整个 npm/Vite/esbuild 进程树的方案。

### 路线三：宿主创建匿名管道并转发

**吸引力：** 对宿主控制的通信，提前创建句柄再继承到受限进程，有机会避免受限进程重新走 libuv 的命名管道创建路径，同时保留实时读写能力。

**关键边界：** 我们已经在最外层提前创建并继承输出句柄。把这层换成匿名管道，仍不会自动改变 esbuild 在更深一层自行执行的 `spawn(..., {stdio:'pipe'})`。

若要覆盖内部协议通信，需要回答：谁创建每一组管道，句柄如何进入对应的父子进程，以及怎样向 JS 调用方提供兼容的可读 / 可写流。还需处理 EOF、背压、取消、异常退出和句柄清理。这里只是实现要求，尚未证明可作为第三方工具的透明替代。

**倾向：** 可以优先验证我们自有的父子进程协议；如果要声称兼容未修改的 esbuild，需要一个能实际跑通其双向协议的实现，而不只是外层日志转发。

## 4. 两个具体问题

### 问题一：命名管道补 ACE，如何覆盖未修改的第三方 Node 程序？

如果不修改 Node/libuv，是否存在 DSH 已验证或考虑过的机制，使沙箱内第三方程序创建的命名管道获得所需 restricting-SID ACE？还是必须修改 libuv，或拦截相关 Win32 创建与连接调用？

也想确认 DSH 是否评估过这条路线；若选择不做，主要原因是安全边界、覆盖完整性、维护成本，还是其他机制限制？我们尤其希望避免为解决 IPC 而扩大文件写入权限。

### 问题二：匿名管道方案能覆盖内部协议通信，还是仅限 runner 的输出采集？

DSH 的 runner 在捕获输出时，具体是继承宿主已建立的管道、使用文件重定向，还是自行创建匿名管道？这些机制是否仅覆盖宿主到受限命令这一层？

对于 esbuild 这种需要专用 stdin/stdout 双向协议的内部子进程，是否有不修改第三方工具的可运行方案，还是必须适配其启动逻辑？如果有最小实现或测试案例，很希望学习。

## 5. 希望验证的结果

我们的目标是让常见 npm / Node 构建工具在文件写入受限的情况下运行，并保留工具结果、后台日志和手动停止能力。一个方案要算解决了问题，至少需要同时验证：

1. 真实 `npm run dev` → Vite → esbuild 链路能够处理页面 / 模块请求，不能只看服务器打印 ready。
2. 双向 stdin/stdout 协议、日志采集和取消仍正常。
3. Workspace 与明确授予的临时目录之外的写入仍被拒绝。
4. 子进程退出、停止和异常路径不会泄漏句柄或残留进程。

目前我们提供了逐次审批后在沙箱外重新执行的 `escalate` 路径，作为显式的兼容性出口；它不是沙箱机制内的修复。下一步更希望通过上述最小实验判断，补 ACE 或匿名管道能否在保持写入边界的前提下覆盖第三方内部调用。

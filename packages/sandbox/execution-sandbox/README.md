# `@tnega/execution-sandbox`

沙箱缝的 Consumer：一个 `ExecutionProvider` 装饰器，把准备执行的调用交给 `ctx.sandbox`
包装之后再落进程。

```
@tnega/sandbox-local (Provider) ─┐
                                 ├─→ @tnega/sandbox (ctx.sandbox)
本包 (Consumer) ─────────────────┘
```

## 它做什么

```ts
const execution = sandboxedExecution(ctx, {
  policy: resolveSandboxPolicy({ mode, workspaceRoot, sessionId }),
  inner: localExecutionProvider,   // 可替换，默认就是它
  shellPath: '/bin/sh',            // POSIX
  shell: { command: 'cmd.exe', args: ['/d', '/s', '/c'] },  // Windows
  confineProcess: true,            // 默认也包无 shell 的 argv 进程
})
```

- `runShell`：把命令装成**显式 argv**（POSIX `['/bin/sh','-c',command]`，Windows
  `[comspec,'/d','/s','/c',command]`），交给 `ctx.sandbox.confine`，再用无 shell 的
  `runProcess` 落进程。

  包装发生在 argv 层而不是重写命令字符串，所以 shell 内建命令、管道、重定向、`cd`、
  `export` 都仍然在**同一个受限进程内**执行，中间也没有第二层引号。
- `runProcess`：默认受限（`confineProcess: true`）；部署方可用 `false` 让无 shell 的 argv
  进程透传。
- `fetchHttp`：透传。当前没有任何后端限制网络，所以词汇里也没有这一维。
- `bypass`：整条链透传 —— 那是调用方显式选择的「不沙箱」。

## 失败语义

Provider 交不出受限 argv 时 `confine` 会抛出（通常是
`SandboxUnavailableError` / `SANDBOX_UNAVAILABLE`），这里**不捕获**：宿主上无法沙箱必须
让调用方看见并放弃执行，而不是回退到非受限执行。没有挂载 Provider 时给出明确错误，而不是
静默返回一个不受限的边界。

## 挂载

本包不注册服务、也不挑选 Provider（那是 composition 的事）：

```ts
await root.plugin(sandboxLocal, { workspaceRoot })
await root.plugin(builtinTools, { cwd, execution: sandboxedExecution(root, { policy }) })
```

## 测试

`test/execution-sandbox.test.ts` 用一个记录 argv 的 stub Provider 与一个假执行边界，覆盖：
命令被装成显式 argv、argv 进程的处理与开关、`bypass` 透传、无可用后端时**不回退**、
没有 Provider 时给出明确错误、网络透传。

# Background jobs

参考 DSH 的 jobs / jobs-local / tool-jobs，按能力缝分成三个角色：

- `@tnega/jobs`：Service Definition，拥有 `ctx.jobs`、Job 词汇和 `jobs/change`。
- `@tnega/jobs-local`：进程内 Provider。管理归属、状态、取消、等待和资源清理。
- `@tnega/tool-jobs`：Consumer，注册 `job_start`、`job_list`、`job_output`、`job_kill`。

Provider 与 Consumer 只依赖 Definition；composition 层选择 Provider。
发布入口是 `tnega/jobs`、`tnega/jobs-local`、`tnega/tool-jobs`。

```json
{"tool":"shell","input":{"command":"pnpm test"},"label":"test suite"}
```

把上面的参数交给 `job_start`，立即取得 `{job_id,status}`，继续处理独立工作。
要后台运行 Subagent，使用：

```json
{"kind":"subagent","task":"检查指定模块并报告发现","mode":"spawn"}
```

Subagent 仍经过 `spawn_subagent` 的原有工具授权，保留深度、并行数量、Workspace
权限和 durable Session。该次运行由 job controller 报告完成，避免重复父级通知；
原有 `spawn_subagent` 与 `send_agent_message` 的继续交互行为保持不变。

长期运行的命令（dev server、watcher）也走 job：

```json
{"tool":"shell","input":{"command":"npm run dev"},"wait_for_url_ms":15000}
```

声明了 `metadata.backgroundProcess` 的工具（`shell`）在 job 里不等命令退出：
tool-jobs 传入执行选项 `adoptBackgroundProcess`，shell 经同一执行边界（同一沙箱）
启动后台进程、登记到 workspace 的 `ProcessRegistry` 并交出句柄。`job_start` 在
命令启动后（含审批）返回首段输出，`wait_for_url_ms` 可再等本地 URL；运行中
`job_output` 只返回上次读取后的新输出（`all:true` 取全部）、状态与本地 URL，
Windows 沙箱下附带 `note` / `hint`；`job_kill` 停止整个进程树。进程退出码 0 为
`completed`，否则 `failed`。原 `process_start` / `process_output` / `process_list` /
`process_stop` 工具已移除。

Job 可在运行中提供 `progress()`（输出、URL、`processId`），快照与 `jobs/change`
因此带上 `urls` / `processId`。Owner 或 registry 卸载时以 `JobOwnerDisposedError`
取消：Web 的 workspace registry 是共享的，此时进程不被杀，而是留在 workspace 里
（设置变更重建运行时不会停掉 dev server），用户仍可在 Tasks 里停止；没有共享
registry 时进程随 builtins 插件结束。

读取结果：`job_output({job_id,wait:true,timeout_ms:30000})`。
默认不等待；等待默认 30 秒、上限 60 秒，超时返回当前状态并保留工作。
调用方取消 signal 只取消这次等待。`job_kill({job_id,reason})` 请求取消工作，
状态先变成 `stopping`，直到执行方释放资源才变成 `killed`。

状态：`running → stopping? → completed | failed | killed`。输出是幂等的最终文本，
由 Session 的 `renderToolResult` 渲染，不支持逐块流式读取。后台工具仍通过
ToolsService 的校验、授权、guard、deadline、post-execute/spill 管线；不继承父调用的
临时提权标记，不共享启动调用的取消 signal。支持 `metadata.background: false`
禁止某个工具被后台执行；job 控制工具不能再嵌套后台。

每个 live Agent 只能读取/取消自己生命周期内的 job。没有 Agent identity 的程序化
调用创建 runtime 自有的 job。任务跨 Agent Run 保留，所属 Agent 或 registry 的
Fiber 卸载时取消并等待结束。工具必须响应 signal；不响应取消的工具无法被任意
强制停止，卸载会等待其退出。进程重启不恢复 job；Subagent 的原 Session 保留。

启动意图和结果写入 Session 的 `job/dispatch-*` meta，不伪造额外的模型 tool 消息。
未被等待/读取/取消的完成通知写入所属 Agent 的 durable next-step inbox：忙碌时在
下一个 step 消费，空闲时留待下一次 activation，不额外自动开启模型请求。

默认每个 owner 最多 8 个 live job，registry 最多保留 256 条；到达保留上限时只
淘汰已收集的终态记录，否则拒绝新任务。`jobsLocal` 可配置 `maxConcurrent` 与
`maxRetained`；`toolJobs` 可配置 `waitTimeoutMs`、`maxWaitTimeoutMs`、
`maxOutputChars`（默认 64000）和 `resolveSession`。

CLI 默认随 builtin tools 启用。自定义 `builtinTools:false` 时可用 `jobs:true`
单独启用；`jobs:false` 可禁用。Web resident Agent 与 Project Thread 同样挂载。
Subagent job 要求 composition 同时加载 agents、subagent Provider 和 tool-subagent。

Web 对话标题右侧的 Tasks 显示后台任务数量，展开后可查看状态和输出，或点击
Stop 人工停止执行；后台进程另列出 workspace 中已脱离会话仍在运行的进程。停止通过取消 signal 实现，状态先显示 Stopping，再保留
Stopped 记录与已有结果；前台回合结束后面板继续更新。

测试：`packages/jobs/jobs-local/test/`、`packages/jobs/tool-jobs/test/`。

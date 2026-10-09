# `@tnega/thread-local`

`ctx.threads` 的本地 Provider：一个 Thread 一个文件夹，身份与状态记在 Blackboard。

## 落盘形状

```
<root>/agents/<threadId>/session.jsonl     # root = <workspace>/.tnega/projects/<projectId>
```

组合层可传入 `sessionRoot`，把历史放到
`<sessionRoot>/agents/<threadId>/session.jsonl`。未传时保持上述默认位置；
`root` 仍负责原有身份目录，其余项目文件与工作目录不受影响。此选项不自动迁移旧历史。

## Git 工作目录与交付

CLI Host 在 Git Workspace 中为每个执行 Thread 建立独立 worktree 和
`codex/thread-<projectId>-<threadId>` 分支，从原工作区的已提交 HEAD 开始；原工作区
未提交的改动不会复制、暂存或改写。每个 Thread 的文件、搜索、Office、skills、后台
工具、CodeMode 子调用和按路径发布产物都使用自己的 cwd，共享 Blackboard 与
Artifact Store 保持 Project 作用域。非 Git Workspace 沿用原目录，不虚构 PR。

`ThreadRecord.workspace` 保存 cwd、branch、baseCommit、baseBranch，以及成功交付后
的 `pullRequest: {url, number, headCommit}`。旧记录缺字段仍可读，下一次激活时准备
工作目录；恢复会复用分支和目录，目录/分支不一致时拒绝运行。worktree 与恢复记录
保留在 Tnega 状态目录，卸载或删除 Project 不自动删除未合并的代码。

有代码改动时，Thread 必须提交并验证，再调用 `deliver_thread({title, body})`。
此工具沿用原权限和审批管线，对 origin 做普通 push，并通过 gh 创建或复用该分支的
单一 PR；核对 open 状态和远程 head 后才记录交付成功。无 origin、认证失败、关闭的
PR 或命令失败均保持 blocked，解决原因后可重试，不强推、不自动合并；已经关闭的 PR
需要新的 Thread 承接后续代码工作。未交付改动不能转为 done/resolved，自动回报为
blocked。无改动的调查 Thread 可正常结束。

Provider 的 `prepareWorkspace` 和 `completionCheck` 是可选宿主 hook，不依赖 Git
或具体 Provider；`setWorkspace` 只供可信宿主写元数据，模型不能指定其他 Thread 的目录。

身份的其余部分（label、goal、expect、state、depth、permission、父子）是同一个
Blackboard 里的 `agent` 记录。`id` 由记录键提供，时间由版本记录提供。

## 取舍

- **协调者只分发**。调查、文件操作、验证和交付都由 Thread 完成；协调者只处理派工、消息、依赖、审批与共享项目知识。CLI 用协调工具白名单同时约束模型工具面和执行守卫，Code Mode 的嵌套调用也不能绕过它。

- **通信是短消息**。协调者与 Thread 默认一条消息一个主题、1–3 个短句；派工给范围与验收条件，后续只传约束增量、可复用发现、具体阻塞、决定和交付引用。长 brief 与证据放共享文件或产物，不反复转发完整历史。`send_project_message` 可在工作中连续发布有意义的独立气泡，最终回报仍由 Project Loop 自动发布，不重复发送。模型可按用户明确要求展开详情，提示词不截断持久消息。

- **两边各存各的**。可恢复配置在 Blackboard，模型历史只在该 Session 的 JSONL 里；两者
  通过 `threadId` 关联，不互相复制。这样「Blackboard 不复制完整对话」与「Session 是模型
  可见历史的真源」同时成立。
- **`ensureRoot` 只保证身份**。协调者 Thread 的记录与目录在第一次打开 Project 时建立，
  真正开始跑要等 `activate` —— 创建 Project 不该顺手拉起一个 Agent。
- **激活有单例保证**。同一进程里同一个 Thread 只会有一个 `LiveAgent`；并发 `activate`
  共享同一个 promise。恢复用 `AgentRegistry.resume`，因此回到的是同一个 Session。
- **运行时更新按身份串行**。同一 Thread 的状态与清单修改按调用顺序读最新记录并条件提交，避免审批等待与 Run 状态竞争或相互丢失字段；不同 Thread 可并行更新。
- **只建到 Thread 那一层**。Provider 只创建 `agents/<threadId>/`；子目录由需要它的 Provider
  自己建。
- **委派只收窄**。权限取父子中更窄的一个；深度与并行数超限以 `THREAD_LIMIT` 拒绝，而不是
  排队等一个空位。
- **记录损坏时收窄而不是放宽**。`agent` 记录缺少或无法解析 `permission` 时按
  `read-only` 处理。

# 密钥库：值只交给命令，名字才进会话

> 状态：当前
> 取代关系：无
> 当前实现：`packages/secrets/README.md`、`packages/secrets/secrets/README.md`、`packages/secrets/secrets-local/README.md`、`packages/secrets/execution-secrets/README.md`、`packages/secrets/tool-secrets/README.md`

日期：2026-10-26。

## 背景

Agent 需要 `GITHUB_TOKEN` 这类密钥才能干活，但密钥一旦进入模型上下文或 Session，
它就永久留在了时间线、日志、压缩摘要和下一次发给模型的请求里。此前的做法是让用户
自己把密钥写进 shell 命令或 `.env`：前者进入工具调用参数，后者进入工作区文件，两条
路都把值暴露给了模型可见的位置。

因此需要一个“Agent 只知道名字、值只到达命令环境”的能力：Agent 用
`ask_user_question` 的 `secret` 字段要一个名叫 `GITHUB_TOKEN` 的密钥，用户在隐藏输入框
里输入，值进宿主侧的密钥库，命令通过环境变量读到它。

## 决策

1. **三段式能力缝**（照 ADR 0006）：`@tnega/secrets` 定契约 `ctx.secrets`；
   `@tnega/secrets-local` 是 Provider；`@tnega/execution-secrets`（注入命令环境）与
   `@tnega/tool-secrets`（掩码工具输出）是 Consumer。`@tnega/user-questions` 也消费它：
   密钥答案只写进库，Session 里留 `{ name, remembered }`。
2. **两个作用域**：会话内（宿主内存，Session 删除或 tnega 退出即消失）与工作区（落盘，
   重启后该工作区所有 Session 可用）。会话值覆盖同名的已记住值；`remove` 两者都删。
3. **持久化格式**：`<tnega home>/secrets.json`，权限 `0600`，
   `{ version: 1, workspaces: { <workspaceStorageKey>: { path, secrets: { NAME: value } } } }`。
   写入是整文件替换：同目录临时文件 + `chmod 0600` + `rename`，并按序串行化。空的工作区
   条目在写回时被清掉。`secrets` 映射是 null 原型对象，因此 `__proto__` 这类名字仍然是
   普通自有键；判断“是否存在”用 `Object.hasOwn`，继承来的 `toString` 不算已存密钥。
4. **兼容与迁移**：文件缺失视为空库；`version` 不是 1、不是合法 JSON、或结构不符时
   **报错并指出文件路径**（提示用户修或删），不做静默丢弃，也不做迁移——当前只有 v1。
   未知字段在读取时被忽略，写回时按 v1 结构重写。
5. **名字校验**：必须是环境变量名。拒绝 `PATH`、`HOME`、`NODE_OPTIONS`、`LD_PRELOAD`
   等命令启动/加载所依赖的变量，拒绝 `TNEGA_` 前缀，并整族拒绝
   `LD_` / `DYLD_` / `NPM_CONFIG_` / `JAVA_` / `_JAVA_` / `GIT_CONFIG_`：这些族里的任意
   一个变量都能改变命令加载什么代码、从哪里取包，密钥放在那里等于让值变成配置。
   不整族拒绝 `GIT_`（`GIT_TOKEN` 之类是正当名字），只拒绝能改执行的
   `GIT_DIR` / `GIT_WORK_TREE` / `GIT_SSH_COMMAND` / `GIT_EXEC_PATH` 与 `JDK_JAVA_OPTIONS`。
6. **权限边界**：值只出现在两处——子进程环境，以及被掩码后的文本。`list()` 只给名字。
   掩码在 `tools/post-execute` 前置执行，因此溢出落盘看到的是已掩码文本；实时
   `progress` 走跨块的流式掩码，值被切开也认得出。掩码集合是
   `SecretStore.maskingEntries()`：当前值 **加上** 本作用域内已经交给过命令的每个值
   （`noteInjected` 记账）。这样“命令启动后用户删掉密钥、结果随后返回”仍然掩码；
   只按调用前的快照掩码会漏掉这一步。

## 已知限制

- 掩码挡住的是普通输出、base64/base64url/URL 编码形式。它是“别把密钥写进剧本”的保险，
  不是防恶意命令的墙：命令本来就能读到值，也能把它算成别的形式发出去。
- 值小于 4 个字符不掩码（会把普通输出打烂）。
- 沙箱不隔离读：受限命令仍可读 `~/.npmrc` 之类文件，密钥库只是其中一条路径的更好答案。
- 已交给命令的值在作用域内一直保留用于掩码，内存随用户输入过的密钥数量增长。

## 后果

- Web 与 TUI 各有输入与记忆控件；设置里的 Secrets 分区只列名字并可移除。Projects
  模式下不传 `sessionId`，因此不会列出某个后台会话的会话级密钥。
- `secretEnvExecution` 与 `tool-secrets` 通过同一个 `ctx.secrets` 实例共享记账，
  不引入新的服务。

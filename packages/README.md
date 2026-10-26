# packages/

包按**能力域**分组：一条能力缝的三个角色（Definition / Provider / 模型可见 Consumer）
放在同一个域目录里，找 provider 不必先知道它叫什么。

```
packages/<域>/<包>
```

顶层目录（`tools`、`agent`、`session`、`core` 等）是各域共用的基础设施，自身不构成域。
`tools` 只有工具注册表、执行管线与共用词汇，**不注册任何模型可见工具**。

## 能力域

| 域 | 包 | 提供的能力 |
|---|---|---|
| `agent/` | `agent` | 循环、inbox、steer、恢复、continuation、提示词组装 |
| `approval-*` | `approval-host`、`approval-review`、`approval-llm`、`approval-openai`、`approval-jev`、`auto-approval` | 审批策略与自动评审 |
| `browser/` | `browser`、`browser-playwright`、`tool-browser` | Agent 浏览器 |
| `compaction/` | `compaction` | 自动压缩与标题生成 |
| `config/` | `config` | 系统配置与模型发现 |
| `fs/` | `tool-fs`、`search`（`search-definition`）、`search-ripgrep`、`tool-search` | 文件工具：读、写、编辑、列目录、`glob` / `grep` |
| `fs-sandbox/`* | `fs-sandbox` | 路径围栏（被文件工具与 shell 共用） |
| `goal/` | `goal` | 持久目标 |
| `jobs/` | `jobs`、`jobs-local`、`tool-jobs` | 后台任务（`shell` 的 `runInBackground`） |
| `loop/` | `loop-guard`、`project-loop` | 停滞看护与 Project 循环 |
| `memory/` | `memory`、`memory-local`、`tool-memory` | 用户记忆 |
| `office/` | `office`、`tool-office` | Office 文件的读写与编辑 |
| `project/` | `project`、`project-local`、`blackboard`、`artifact-store`、`thread`、`host`、`http`、`worktrees`、`routines`、`memory`、`tool-*` | Project 协作 |
| `ptc/` | `ptc-runtime`、`ptc-runtime-quickjs`、`tool-ptc` | 程序化工具调用（`run_code`） |
| `questions/` | `user-questions`、`tool-question` | 向用户提问（`ask_user_question`） |
| `shell/` | `tool-shell` | `shell`（后台运行交给 `jobs/`） |
| `sandbox/` | `sandbox`、`sandbox-local`、`sandbox-windows-acl`、`sandbox-windows-mxc`、`execution-sandbox` | 执行边界 |
| `session-search/` | `session-search`、`tool-session-search` | 会话检索 |
| `spill/` | `spill`、`spill-local`、`tool-spill` | 工具结果溢出 |
| `subagent/` | `subagent`、`subagent-local`、`tool-subagent` | 子 Agent |
| `web/` | `tool-web-fetch`、`tool-web-search`、`web`、`web-kit` | 网络工具（`http_get`、`web_search`）与 Web 宿主套件 |

\* `fs-sandbox` 目前在 `packages/sandbox/fs-sandbox`，与执行边界同域。

## 工具索引

模型看到的工具名与承载它的包。新增工具时同时更新这里与
`docs/design/tnega-design.md`。

| 工具 | 包 | 默认挂载 |
|---|---|---|
| `shell`（含 `runInBackground`） | `shell/tool-shell` + `jobs/tool-jobs` | 有 shell 时 |
| `read_file` `write_file` `edit_file` `list_dir` | `fs/tool-fs` | 是 |
| `glob` `grep` | `fs/tool-search` | 是 |
| `http_get` | `web/tool-web-fetch` | 有网络时 |
| `now` | `project/host`（`clock.ts`） | Project |
| `job_list` `job_output` `job_kill` | `jobs/tool-jobs` | 挂 jobs 时 |
| `skill` | `coding-agent` | 是 |
| `office_inspect` `office_read` `office_create` `office_edit` | `office/tool-office` | 工作区有 Office 文件时 |
| `run_code` | `ptc/tool-ptc` | 开启 CodeMode 时 |
| `ask_user_question` | `questions/tool-question` | 有用户问答服务时 |
| `remember_global` | `memory/tool-memory` | 挂 memory 时 |
| `spawn_subagent` `list_subagent` `read_subagent_result` | `subagent/tool-subagent` | 挂 subagent 时 |
| `get_goal` `update_goal` | `goal` | Project |
| `browser_*` | `browser/tool-browser` | 有浏览器时 |
| `web_search` | `web/tool-web-search` | 有搜索凭据时 |
| `*`（Project 协作） | `project/tool-*` | Project |

`echo`、`calculator`、`json` 已删除：`shell` 覆盖它们，它们的 schema 却每次请求都要付费。
`runtime` 的 `builtinTools` 是组合层的 bundle：它按 `allowShell` / `allowNetwork` 决定挂
`tool-fs`、`tool-shell`、`tool-web-fetch` 中的哪些，本身不实现任何工具。

## 加一个包

`pnpm-workspace.yaml`（分组目录要加 `packages/<域>/*` 一行）、
`scripts/build.mjs` 的 `packageDirs` 与 `libraryEntries`、
根 `package.json` 的 `exports` 类型路径、
`src/index.ts` 的 re-export。漏任何一处都表现为「本地测试通过、打包后 404」，
所以改完跑一次 `pnpm test:package`。

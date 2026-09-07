# `@tnega/cli`

CLI 命令、agent runtime 组合层、web server 与会话存储。

## 命令

```
tnega run "prompt"                       # 一次 agent 会话
tnega web                                # 本地 web UI（HTTP + SSE，127.0.0.1:3080）
tnega eval run tasks.yml                 # 跑评测
tnega eval compare <base> <head>         # 比较两次评测
tnega eval import-benchmark --...        # 导入真实 benchmark（见 packages/benchmark）
tnega evolve run tasks.yml               # 自进化循环
```

`run` 选项含 `--model / --base-url / --max-tokens / --temperature / --cwd / --session /
--timeout-ms / --max-retries / --retry-delay-ms / --allow-network / --allow-shell`。

## runtime 组合层（产品形态 = 组合）

`profile.ts` / `profile-file.ts` / `commands.ts#createAgentRuntime` 提供共享启动层：

- `AgentProfile`：`{ name, bundles, options }`，bundle 先装，profile 默认选项与调用方
  overlay 后覆盖。
- `bootAgentRuntime` / `bootAgentRuntimeFromFile`：profile + overlay → runtime options。
- `createAgentRuntime` 接受 `AgentDefinition` / `SessionProjector` / `ToolPolicy` /
  `builtinTools: false` / 自定义 `inbox` / `plugins`；`llm` 可选。web / headless / eval
  三种产品形态复用同一工厂，差异全在组合与薄消费者代码。

profile 文件：`~/.tnega/profiles/<name>.json`（Windows）或
`$XDG_CONFIG_HOME/tnega/profiles/<name>.json`，可引用内置 bundle 名或内联插件。

## web server（server.ts）

- 原生 `node:http` 极简 router，零运行时依赖。
- `POST /api/sessions/:id/runs` 返回 SSE；断连即取消；同 session 仅一个 active run。
- coding 会话支持 `auto / plan / execute`；plan 面板通过 `plan/*` 事件实时推进。
- `/api/coding/commands` / `slash` / `slash-candidates`。
- 跨站防护：JSON content-type + `x-tnega-client: 1`。

## 会话存储（store.ts）

工作区 `.tnega/sessions/<id>.jsonl`。**head `meta` 事件 + `meta/patch` 事件**都是
不可变事实：标题 / agentType / mode 由事件折叠而来（`foldSessionMeta`），改名走
append-only `meta/patch`，不整写文件——因此崩溃与并发下标题与模式保持可重建。

创建、fork、截断、删除、compact、title 都在此。会话的模型消息由底层 `SessionLog`
(append-only) 与 `compactSession`（checkpoint 替换）维护。

## 系统配置（config.ts）

独立于工作区，位于用户主目录：`apiKey` / `model` / `baseUrl` / `temperature` / 工作区列表。
env > config file > 默认。Windows：`%USERPROFILE%\.tnega\config.json`。

## 测试

`packages/cli/test/`：CLI 端到端、runtime 组合、profile 文件、store 元数据、
web 协议、工具端到端。web 前端单测在 `apps/web/src/*.test.ts`。

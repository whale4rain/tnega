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
- `createAgentRuntime` 接受 `AgentDefinition` / `ToolPolicy` /
  `builtinTools: false` / 自定义 `inbox` / `plugins`；`llm` 可选。默认组合会挂载
  prompt 组装 seam（`systemPrompt`）并把可执行工具注册为 schema 提供者。web / headless /
  eval 三种产品形态复用同一工厂，差异全在组合与薄消费者代码。

profile 文件：`~/.tnega/profiles/<name>.json`（Windows）或
`$XDG_CONFIG_HOME/tnega/profiles/<name>.json`，可引用内置 bundle 名或内联插件。

## web server（server.ts）

- 原生 `node:http` 极简 router，零运行时依赖。
- `POST /api/sessions/:id/runs` 返回 SSE；断连即取消；同 session 仅一个 active run。
- coding 会话支持 `auto / plan / execute`；plan 面板通过 `plan/*` 事件实时推进。
- `/api/coding/commands` / `slash` / `slash-candidates`。
- coding 会话支持 Auto、Plan、Goal。Plan 只生成计划；Goal 状态记在 Session 中，
  最多自动推进 5 轮，可用 `/goal` 控制或 `get_goal` / `update_goal` 工具更新。
- 运行权限为 read-only、workspace-write、bypass。read-only 可抓取公开网页，
  `web_search` 使用 DeepSeek 原生搜索；需要 `DEEPSEEK_API_KEY` 或 DeepSeek 模型凭据。
  超出权限的工具调用经 SSE 发送一次性批准请求，并由 `POST /api/sessions/:id/approvals/:approvalId` 回答。
- auto 会话使用 resident Agent；子代理通过 `spawn_subagent`、`list_subagent`、
  `send_agent_message` 工具工作。`GET /api/sessions/:id/subagents` 列出子代理，
  `GET /api/subagents/:id` 读取独立 Session。状态面板每 2 秒刷新。
- 跨站防护：JSON content-type + `x-tnega-client: 1`。

## PTC 与提问

默认 runtime 提供 `run_code`，由独立 QuickJS Worker 执行 JavaScript。使用
`await tools.read_file({path: 'README.md'})` 调用已有工具，`ALL_TOOLS` 查看名称和参数 schema，
`text(value)` 输出结果。程序没有直接文件、网络或子进程能力；子调用沿用原审批与沙箱。
第一版子调用串行执行，`Promise.all` 也不并行；失败脚本不会自动重试。期限默认 5 分钟，
包括工具审批与阻塞提问的等待；工具、输出和 VM 内存有独立上限。每次调用创建新 VM。
程序化组合可通过 `createAgentRuntime({..., ptc: {mode: 'native' | 'both' | 'ptc'}})`
选择工具面，默认 `both`。PTC 使用 Pi 的独立 CodeMode 库，不依赖 Pi Agent。
显式传入自定义 `AgentDefinition` 时保留其工具面，默认 `native`；设置 `ptc.mode` 后才加入编排入口。

Web 会话另外挂载独立 `ask_user_question` 插件。`mode: 'blocking'` 等待用户提交，
答案作为原工具结果返回；`nonblocking` 立即返回 pending，用户提交时进入 steer 队列。
Run 已结束时，前端接续现有 SSE 通道处理已持久化队列，仍可显示后续工具审批。
请求格式为 `{mode, questions: [{id, question?, options?: [{label, description?}], multiple?, optional?}]}`；
答案为 `{answers: [{questionId, selected?: string[], text?: string}]}`。问题文字和选项可空，
每题始终保留自由文本框；`optional:true` 允许跳过，默认选择不构成回答。
`GET /api/sessions/:id/questions` 查询，`POST /api/sessions/:id/questions/:requestId` 提交。
仅当前主会话可向该界面提问，子代理不会创建用户看不到的阻塞等待。

问题与 PTC 审计使用独立 meta，不参与模型/权限配置解析。重启可以恢复非阻塞问题；
没有等待执行者的阻塞问题不会重新恢复旧工具调用。停止 Run 可取消阻塞等待。

## 会话存储（store.ts）

工作区 `.tnega/sessions/<id>.jsonl`。**head `meta` 事件 + `meta/patch` 事件**都是
不可变事实：标题 / agentType / mode 由事件折叠而来（`foldSessionMeta`），改名走
append-only `meta/patch`，不整写文件——因此崩溃与并发下标题与模式保持可重建。

创建、fork、截断、删除、compact、title 都在此。会话的模型消息由底层 `SessionLog`
(append-only) 与 `compactSession`（checkpoint 替换）维护。

## 系统配置（config.ts）

独立于工作区，位于用户主目录。Windows：`%USERPROFILE%\.tnega\config.json`。
原有单模型字段继续可用；`models` 可配置多个可切换路由。`id` 是 Session 里持久的选择键，
`model` 是发给提供商的模型 ID（省略时与 `id` 相同）。`baseUrl`、`protocol`、
`apiKeyEnv`、`reasoningEfforts` 和 `contextWindow` 都可按模型配置；未声明思考档位的自定义模型只使用端点默认行为。
模型选择只列出当前默认模型和 `models` 中显式配置的模型；不会自动列出其他内置模型。
`contextWindow` 是正整数，单位为 token，用于会话上下文占用显示；模型配置优先于顶层默认值。

```json
{
  "model": "fast",
  "models": [
    {
      "id": "fast",
      "model": "deepseek-v4-flash",
      "name": "Fast",
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "protocol": "openai",
      "apiKeyEnv": "OPENCODE_GO_API_KEY",
      "contextWindow": 1000000
    },
    {
      "id": "reasoner",
      "model": "gpt-5.2",
      "name": "Reasoner",
      "baseUrl": "https://api.openai.com/v1",
      "protocol": "openai",
      "apiKeyEnv": "OPENAI_API_KEY",
      "contextWindow": 128000,
      "reasoningEfforts": ["low", "medium", "high"],
      "reasoningEffort": "medium"
    }
  ]
}
```

每次请求读取配置文件，因此修改后无需重启；Settings 小窗里的 Reload file 可刷新选择列表。
`apiKey` 也可逐模型填写，但 `apiKeyEnv` 可避免将密钥写入文件。

## 测试

`packages/cli/test/`：CLI 端到端、runtime 组合、profile 文件、store 元数据、
web 协议、工具端到端。web 前端单测在 `apps/web/src/*.test.ts`。

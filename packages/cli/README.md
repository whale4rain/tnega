# `@tnega/cli`

CLI 命令、agent runtime 组合层、web server 与会话存储。

ChatGPT OAuth 授权码兑换、token 刷新与 Responses 请求共用宿主网络配置：
Settings → Tools & shell → Network 的代理优先，然后使用环境代理或桌面系统网络。
本机 OAuth 回调仍通过 localhost 接收。OpenAI 返回的地区限制错误不会被屏蔽。

Project Thread 的具体工具调用在自动 review 返回 `ask`（包括 reviewer 无效输出）时保持等待，
由宿主通过 Box 自动送到直接父 Agent。父 Agent 的 `decide_thread_approval` 可以一次性批准、
拒绝，或以 `ask-user` 转交已有的 Project 人工审批通道；普通留言不能批准调用。
批准只恢复原调用，不提升 Session 权限或覆盖明确的 review 拒绝。请求最多等待两分钟，
取消、Project 卸载及进程重启使旧请求失效，原调用不会自动重放。
Session `approval/delegation` 保留请求 ID、调用 ID、父 Agent、决定及来源，已有 Session 无需迁移。

Project 主对话和 Thread 输入框允许运行中异步发送，并分别提供 Stop 与 Interrupt and send。
主对话 Stop 只取消协调者，其他 Thread 继续运行；Pause all work 仍取消所有正在运行的 Agent。
两个消息 API 可携带可选布尔 `interrupt: true`，纠正通过 Box 持久投递后中断目标当前 Run，
保留此前已接收的输入。普通消息仍等安全 step 边界；取消不回滚已经完成的工具效果。

普通 Session 在运行中也可继续发送 steer 消息，独立 Stop 仍停止当前 Run。
`POST /api/sessions/:id/steer?workspace=...` 接收 `{prompt, attachments?}`，
将文字与图片持久写入当前 Agent 的 next-step inbox，在安全 step 边界读取；
不会取消正在执行的模型请求或工具，也不会另开并发 Run。没有活动 Run 时返回 409。

Background Tasks 同时展示 Session 的 Job 与 Workspace 共享的长驻进程。
`GET /api/processes?workspace=...` 列表、加 `process_id` 读取有界日志；
`POST /api/processes?workspace=...` 携带 `{action:"stop",process_id:"..."}`
直接停止该工作区注册的进程树，无需 Agent 审批。读取不会消费 Agent 的输出游标，
进程跨 Agent Run 保留，停止后保留日志；服务端重启不恢复。Project 使用同一注册表。

## 命令

```
tnega run "prompt"                       # 一次 agent 会话
tnega web                                # 本地 web UI（HTTP + SSE，127.0.0.1:3080）
```

`run` 选项含 `--model / --base-url / --max-tokens / --temperature / --cwd / --session /
--timeout-ms / --max-retries / --retry-delay-ms / --allow-network / --allow-shell`。

## runtime 组合层（产品形态 = 组合）

Settings → Instructions 保存一条 Workspace 用户提示词，存于 home 的 Workspace
状态目录 `user-prompt.txt`（最多 32000 字符）。`workspacePrompt` 通过 `systemPrompt`
动态 section/context 机制与请求头前缀注入，每次请求重新读取，支持直接清除。
CLI runtime 与 Web/桌面 resident runtime 使用相同组装；已有 Session 格式不变。

`profile.ts` / `profile-file.ts` / `commands.ts#createAgentRuntime` 提供共享启动层：

- `AgentProfile`：`{ name, bundles, options }`，bundle 先装，profile 默认选项与调用方
  overlay 后覆盖。
- `bootAgentRuntime` / `bootAgentRuntimeFromFile`：profile + overlay → runtime options。
- `createAgentRuntime` 接受 `AgentDefinition` / `ToolPolicy` /
  `builtinTools: false` / 自定义 `inbox` / `plugins`；`llm` 可选。默认组合会挂载
  prompt 组装 seam（`systemPrompt`）并把可执行工具注册为 schema 提供者。web / headless 两种产品形态复用同一工厂，差异全在组合与薄消费者代码。

profile 文件：`~/.tnega/profiles/<name>.json`（Windows）或
`$XDG_CONFIG_HOME/tnega/profiles/<name>.json`，可引用内置 bundle 名或外部插件模块。

### 从文件加载外部插件

`tnega run "prompt" --profile ./agent.yaml` 可读取 JSON、YAML 或 YML profile。
程序化使用 `readAgentProfile` 或 `bootAgentRuntimeFromFile`（发布入口为
`tnega/cli/runtime`）。例如：

```yaml
name: custom
bundles:
  - general
  - module: my-tnega-plugin
    config:
      greeting: hello
  - module: ./plugins/custom-tools.mjs
    export: customTools
    config:
      enabled: true
  - module: ./plugins/optional.mjs
    disabled: true
options:
  builtinTools: false
```

- `module`：npm 包、本地相对/绝对路径或 `file:` URL。相对路径与 npm
  包查找均以 profile 文件位置为基准，不以 Tnega 安装目录为基准。
  在外部应用安装 `tnega` 与自己的插件包，再把 profile 放在该应用内。
  包入口使用 Node 可解析的 `exports`（推荐 `"exports": "./dist/index.js"`）。
- `export`：指定命名导出；省略时使用 default，没有 default 时使用模块的
  `apply`/`inject` 导出。支持函数、Service 类和带 `apply` 的插件对象。
- `config`：原样传入插件的第二个参数；插件负责校验，沿用核心已有的
  `Config` 处理机制。必需服务继续由插件自身的 `inject` 声明。
- `disabled: true`：跳过模块解析、导入与挂载。

外部插件使用 `tnega/core` 等公开入口，建议把 `tnega` 声明为兼容版本的
peer dependency，并将 TypeScript 编译为 JS 后加载。插件在宿主进程中执行，
profile 应只引用信任的代码；工具沙箱不会隔离插件本身。

文件读取时先解析全部模块，再由 runtime 挂载插件。配置插件启动失败会释放
已创建的 runtime；正常 `runtime.dispose()` 会撤销插件注册和 effects。
`tnega run` 读取一次 profile；修改后下一次运行生效。常驻宿主（`tnega web` 与桌面端）
使用下文的热重载。
原有程序化 `AgentProfile.bundles: Plugin[]` 保持可用。

### 插件热重载（HMR）

`tnega web` 与桌面端在运行中加载 `~/.tnega/profiles/default.{yaml,yml,json}`
（`tnega web --profile <file>` 可换文件，`--no-plugins` 关闭）。文件不存在时宿主照常启动，
创建后自动加载。`createHotPluginHost(file)`（`tnega/cli/runtime`）提供同一能力：

- 监听 profile 文件与每个本地插件模块所在目录（忽略 `node_modules`、`.git`），
  120ms 防抖后重新读取 profile。
- 本地模块以新的 `?tnega-hmr=<generation>` URL 导入；一个 Node 同步 resolve hook 把这一
  代号传给它导入的本地文件，所以改辅助文件也会生效。`node_modules` 中的包属于框架层，
  不重载，改动后重启宿主。
- `host.plugin` 是一个载体插件：挂到任意 runtime（Web 每次运行的 runtime 与常驻 Agent
  都挂了），它把当前一代插件挂成子 Fiber；重载时按逆序 dispose 旧一代，再挂新一代。
  新一代挂载失败时回滚到旧一代；读取或导入失败时旧一代继续运行。
- `GET /api/plugins` 返回 `{enabled, file, generation, plugins, error?}`，
  `POST /api/plugins/reload` 立即重载。旧一代模块留在内存中，适合开发期迭代。

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

后台任务默认随内置工具启用，提供 `job_start`、`job_list`、`job_output`、`job_kill`。
Web resident Agent 和 Project Thread 也可使用。任务跨 Agent Run 保留，权限继续由
原工具管线检查；runtime 关闭会取消并等待任务。完整用法与配置见
[Background jobs](../jobs/README.md)。自定义 runtime 的 `builtinTools:false`
保持原工具面，可显式设置 `jobs:true` 单独启用；`jobs:false` 禁用默认挂载。

设置中的 CodeMode 默认关闭，此时模型只看到原生工具，且没有 `run_code`。
开启后模型只看到 `run_code`，由独立 QuickJS Worker 执行 JavaScript。使用
`await tools.read_file({path: 'README.md'})` 调用已有工具，`ALL_TOOLS` 查看名称和参数 schema，
`text(value)` 输出结果。程序没有直接文件、网络或子进程能力；子调用沿用原审批与沙箱。
第一版子调用串行执行，`Promise.all` 也不并行；失败脚本不会自动重试。期限默认 5 分钟，
包括工具审批与阻塞提问的等待；工具、输出和 VM 内存有独立上限。每次调用创建新 VM。
程序化组合可通过 `createAgentRuntime({..., ptc: {mode: 'native' | 'both' | 'ptc'}})`
选择工具面，默认 `native`；`both` 仅保留给程序化组合，产品设置不提供。
设置以 `codeMode` 布尔值保存，应用于下一次运行及 Project/Thread。PTC 使用 Pi 的独立 CodeMode 库，不依赖 Pi Agent。
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

默认在 `~/.tnega/sessions/<workspace-key>/<id>.jsonl`；key 是规范绝对工作区路径的
SHA-256（Windows 忽略大小写），可用 `TNEGA_HOME` 改根目录。CLI 默认 `run-vN.jsonl`、
子代理和 Project Thread 历史也在此工作区目录下；Project 的内部消息、身份数据在
`~/.tnega/workspaces/<workspace-key>/`。工具工作目录仍是原 Workspace。

Workspace Usage 的用量与每日/模型汇总缓存保存在该状态目录的 `usage-cache.json`，
不包含对话内容；未变化的历史直接复用，日志、价格或时区变化会刷新对应汇总。
缓存可删除或自动重建，Session 格式无需迁移。

首次访问自动导入旧工作区日志，保留原文件与 mtime；迁移标记防止删除后的会话被旧备份
再次导入。复制前后检查源文件是否变化，同名不同内容或旧进程继续写入时明确拒绝。
升级前先退出旧客户端和 CLI。显式 `--session` 路径仍生效；项目配置、记忆、skills 和
Project artifacts 保留在工作区。迁移不转换 Session 格式。

**head `meta` 事件 + `meta/patch` 事件**都是
不可变事实：标题 / agentType / mode 由事件折叠而来（`foldSessionMeta`），改名走
append-only `meta/patch`，不整写文件——因此崩溃与并发下标题与模式保持可重建。

创建、fork、截断、删除、compact、title 都在此。会话的模型消息由底层 `SessionLog`
(append-only) 与 `compactSession`（checkpoint 替换）维护。

每轮对话的文件改动统计和工作台 Changes 排除内部运行时文件：`.tnega/sessions/`、
默认 CLI 的 `.tnega/run-vN.jsonl`、`.tnega/spill/` 和 Project Thread 的
`.tnega/projects/<projectId>/agents/<threadId>/session.jsonl`。此规则不修改 Git
忽略配置；过滤同时兼容遗留目录。`.tnega/MEMORY.md`、skills、配置和项目产物的改动仍可见。

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

`shell` 选择 `shell` 工具（包括经 `job_start` 后台运行时）使用的系统 shell：名称（`pwsh`、`powershell`、
`bash`、`cmd`、`zsh`…）或可执行文件路径；省略时自动检测（Windows 依次为 PowerShell 7、
Windows PowerShell、Git Bash、cmd；其他平台为 `$SHELL`）。环境变量 `TNEGA_SHELL` 在未配置时
同样生效。Windows 上 `bash` 指 Git Bash，不会选中 WSL 的 `System32\bash.exe`；Git Bash 无法在
Windows 沙箱内运行，只适合完全访问权限。Settings → Tools & shell 可直接选择。

**ChatGPT 登录**：Settings → Models →「Sign in with ChatGPT」用 ChatGPT 套餐代替 API key，流程与
Codex CLI 相同——向 auth.openai.com 发起带 PKCE 的 OAuth，回调到本机 `localhost:1455`，令牌存进
`~/.tnega/auth/chatgpt.json`（仅本人可读）并在过期前刷新。登录后自动添加 `chatgpt` 路由
（`"auth": "chatgpt"`，默认模型 `gpt-5-codex`，可在表单里改），请求走 Codex 后端
`chatgpt.com/backend-api/codex/responses`（Responses API，`protocol: responses`）。若后端只接受
Codex 自己的 instructions，第一次被拒时从 openai/codex 仓库取回并缓存，会话的系统提示改作
developer 消息发送。

`network` 决定 `http_get`（以及经它下载的 skill 安装）怎样上网：

```json
{ "network": { "proxy": "http://127.0.0.1:7890", "allowedHosts": ["docs.example.com", "*.example.org"] } }
```

`proxy` 省略时使用环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（遵守 `NO_PROXY`），
桌面端再退到系统代理（Electron 的网络栈，含 PAC）；Node 自带的 fetch 不读这些设置。
指向私有或保留地址的请求默认被拦截（防 SSRF）；`allowedHosts` 中的主机不论 DNS 解析到
什么都放行——代理的 fake-IP 模式会把所有域名解析到 `198.18.x.x`，被污染的 DNS 会给出
`0.0.0.0`。GitHub、npm、PyPI 的常用主机默认可信。Settings → Tools & shell → Network 可直接修改。

## 测试

`packages/cli/test/`：CLI 端到端、runtime 组合、profile 文件、store 元数据、
web 协议、工具端到端。web 前端单测在 `apps/web/src/*.test.ts`。

## 用户 skills

Web / 桌面首次启动会离线安装内置 skills 到 `~/.tnega/skills`，遵循
`TNEGA_HOME`；默认 CLI runtime、resident Session 与 Project Thread 共用
`skillTools`，让 general 和 coding 都能发现与读取。已有文件不覆盖，工作区
`.tnega/skills` 同名文档优先。自定义 runtime 的 `builtinTools: false` 不默认挂
skills；可以显式指定 `skills: true`，或用 `skills: false` 禁用默认加载。

Skill 管理工具是 `skill_create` / `skill_install`，固定写 home 的 skills 目录，
`workspace-write` 可用，窄权限子 Agent 不能借父权限写入。coding Session 的
`/skills create <name> <description>` 创建模板；`/skills install <工作区路径或HTTPS raw链接> [name]`
导入主文档；`/skills read <name>` 明确读取。已有文件不覆盖，安装不复制附属脚本或
资源。Agent 的 HTTPS 安装要求启用 `http_get`；直接输入 slash URL 是用户对该来源
的读取请求，仍要求写权限。skills 与候选列表实时刷新。

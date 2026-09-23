# Tnega 开发指南

Tnega 是一个 eval-first 的 Agent Harness。核心包将可组合插件生命周期、Agent Run、Session、Tools、LLM 和 Eval 作为平级能力。

## 先定位，再阅读

- 改动领域模型、事件语义或术语时，阅读 `CONTEXT.md`；沿用其中的名称，例如 `Agent Run`、`Session`、`Workspace` 和 `Stream Event`。
- 改动某个包时，先看该包的 `README.md`、`src/` 和相邻的 `test/`。只阅读与当前改动相关的文档和代码。
- 改动公开入口或发布产物时，检查根 `package.json` 的 `exports` 与 `scripts/build.mjs`。
- 改动 Web UI 时，查看 `apps/web/src/` 的对应模块和测试；根 Vitest 配置会发现这些测试。
- 改动 `apps/desktop` 的 Electron 主进程、preload、打包配置、应用图标或安装包时，先阅读 `apps/desktop/AGENTS.md`。

## 代码布局

- `packages/core`：Context、Fiber、Service、Registry 和事件分发的生命周期内核。
- `packages/agent`：Agent loop、durable inbox、live agent、prompt 组装和 LLM service seam。
- `packages/tools`：工具注册表、执行管线与 policy。
- `packages/execution`：本机执行边界（shell / 无 shell 的 argv 进程 / HTTP）的词汇与实现。纯库，无 ctx key，不是缝。
- `packages/search/` 是搜索缝三个角色的容器：`search-definition` 是 Service Definition（`ctx.search`，事件面 `search/*` 也由它拥有）、`search-ripgrep` 是 Provider、`tool-search` 是 Consumer（模型可见的 `glob` / `grep`）。
- `packages/spill/` 是工具输出溢出缝三个角色的容器：`spill` 是 Service Definition（`ctx.spillStore`）、`spill-local` 是文件系统 Provider、`tool-spill` 是 Consumer（`tools/post-execute` 策略，把过大结果换成头尾预览加定位符）。
- `packages/session`：JSONL Session 持久化与重建不变量。
- `packages/eval`、`packages/evolve`、`packages/benchmark`：评测、演化和基准能力。
- `packages/cli`：CLI、配置、工作区和 Web server 组装层；`packages/coding-agent`：coding session 的 plan、skills、MCP 与 slash commands。
- `apps/web`：React/Vite 本地 UI；`src/`：根包的公开聚合导出。
- `apps/desktop`: 客户端实现

## 设计不变量

- 插件注册必须归属于其 Fiber；dispose 后效果按逆序撤销，且不能残留服务、事件监听或子进程。
- 同一作用域的同名服务应明确失败；必需服务写入 `inject`，可选服务通过 `ctx.get()` 取得。
- 能力缝的角色分工与依赖方向见 `docs/adr/0006-capability-seams.md`：Provider 与 Consumer 只依赖 Service Definition，两者互不依赖；Provider 的挑选属于 composition 层，Consumer 不得 import 或枚举具体 Provider。工具输出溢出缝的取舍见 `docs/adr/0007-tool-output-spill.md`。
- 工具结果进入模型上下文的文本只有 `@tnega/session` 的 `renderToolResult` 一个来源：会话折叠、token 估算、Agent 组装请求、溢出策略都读它，不得各自再写一份 `stringify`。
- Agent 的模型可见历史必须能由 durable Session 事件重建；live `agent/*` 事件只用于运行时观察或拦截。
- 工具先记录调用意图、再执行、再记录结果。高权限 shell 与网络能力保持显式 opt-in，路径必须限制在 workspace 内。
- 在调整公共类型、事件名称、生命周期或 package exports 时，同时更新直接消费者与最近的行为测试。

## 实现与验证

- 使用 Node.js 22+ 与 pnpm；保持 TypeScript strict 配置，不通过 `any`、类型断言或 lint disable 绕过错误。
- 将测试放在修改包的 `test/` 目录；Web 测试与源文件同目录。优先覆盖用户可观察行为、生命周期边界和失败路径。
- 改动后运行最小充分验证：
  - 单个测试：`pnpm test -- path/to/file.test.ts`
  - 跨包、公共类型或构建改动：`pnpm typecheck`，必要时再运行 `pnpm test`
  - 代码风格或导入范围较大：`pnpm lint`
  - 发布入口、打包或 Web 产物改动：`pnpm build`；发布行为再运行 `pnpm test:package`
- `dist/` 是构建产物；只通过 `pnpm build` 生成，不手工编辑。

## 工作边界

- 对明确且可逆的仓库内改动直接完成实现、相关验证和必要修复；仅在需求会实质改变产品行为、涉及不可逆操作、凭据/生产环境或外部发布时请求决定。
- 保留用户已有的未提交改动；不要将无关文件或生成物纳入当前提交。
- 依赖、模型提供商、协议或持久化格式变更应说明兼容性与迁移影响；没有明确需求时避免顺手重构。

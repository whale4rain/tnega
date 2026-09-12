# Tnega 开发指南

Tnega 是一个 eval-first 的 Agent Harness。核心包将可组合插件生命周期、Agent Run、Session、Tools、LLM 和 Eval 作为平级能力；Web 应用是其本地控制台。

## 先定位，再阅读

- 改动领域模型、事件语义或术语时，阅读 `CONTEXT.md`；沿用其中的名称，例如 `Agent Run`、`Session`、`Workspace` 和 `Stream Event`。
- 改动某个包时，先看该包的 `README.md`、`src/` 和相邻的 `test/`。只阅读与当前改动相关的文档和代码。
- 改动公开入口或发布产物时，检查根 `package.json` 的 `exports` 与 `scripts/build.mjs`。
- 改动 Web UI 时，查看 `apps/web/src/` 的对应模块和测试；根 Vitest 配置会发现这些测试。

## 代码布局

- `packages/core`：Context、Fiber、Service、Registry 和事件分发的生命周期内核。
- `packages/agent`：Agent loop、durable inbox、live agent、prompt 组装和 LLM service seam。
- `packages/tools`：工具注册、执行管线、policy 与本地执行边界。
- `packages/session`：JSONL Session 持久化与重建不变量。
- `packages/eval`、`packages/evolve`、`packages/benchmark`：评测、演化和基准能力。
- `packages/cli`：CLI、配置、工作区和 Web server 组装层；`packages/coding-agent`：coding session 的 plan、skills、MCP 与 slash commands。
- `apps/web`：React/Vite 本地 UI；`src/`：根包的公开聚合导出。

## 设计不变量

- 插件注册必须归属于其 Fiber；dispose 后效果按逆序撤销，且不能残留服务、事件监听或子进程。
- 同一作用域的同名服务应明确失败；必需服务写入 `inject`，可选服务通过 `ctx.get()` 取得。
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

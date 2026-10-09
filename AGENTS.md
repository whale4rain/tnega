# Tnega 开发指南

Tnega 是一个 Agent Harness。核心包将可组合插件生命周期、Agent Run、Session、Tools 和 LLM 作为平级能力。

## 先定位，再阅读

- 改动领域模型、事件语义或术语时，阅读 `CONTEXT.md`；沿用其中的名称，例如 `Agent Run`、`Session`、`Workspace` 和 `Stream Event`。
- 改动某个包时，先看该包的 `README.md`、`src/` 和相邻的 `test/`。只阅读与当前改动相关的文档和代码。
- 改动公开入口或发布产物时，检查根 `package.json` 的 `exports` 与 `scripts/build.mjs`。
- 改动 Web UI 时，查看 `apps/web/src/` 的对应模块和测试；根 Vitest 配置会发现这些测试。
- 前端实现优先复用仓库已有组件、布局与交互；没有直接适用的组件时，沿用最相近页面的结构和行为。
- 改动 `apps/desktop` 的 Electron 主进程、preload、打包配置、应用图标或安装包时，先阅读 `apps/desktop/AGENTS.md`。

## 代码布局

- `packages/core`：Context、Fiber、Service、Registry 和事件分发的生命周期内核。
- `packages/agent`：Agent loop、durable inbox、live agent、prompt 组装和 LLM service seam。
- `packages/tools`：工具注册表、执行管线与 policy。
- `packages/execution`：本机执行边界（shell / 无 shell 的 argv 进程 / HTTP）的词汇与实现。纯库，无 ctx key，不是缝。
- `packages/search/` 是搜索缝三个角色的容器：`search-definition` 是 Service Definition（`ctx.search`，事件面 `search/*` 也由它拥有）、`search-ripgrep` 是 Provider、`tool-search` 是 Consumer（模型可见的 `glob` / `grep`）。
- `packages/spill/` 是工具输出溢出缝三个角色的容器：`spill` 是 Service Definition（`ctx.spillStore`）、`spill-local` 是文件系统 Provider、`tool-spill` 是 Consumer（`tools/post-execute` 策略，把过大结果换成头尾预览加定位符）。
- `packages/sandbox/` 是沙箱缝的容器：`sandbox` 是 Service Definition（`ctx.sandbox`，事件面 `sandbox/*` 也由它拥有）、`sandbox-local` 是 Provider（bwrap / landlock / seatbelt / Windows ACL 链，功能性探测 + fail closed）、`execution-sandbox` 是 Consumer（`ExecutionProvider` 装饰器）、`sandbox-windows-acl` 是 Windows 机制的实现库（koffi FFI，可选依赖）、`fs-sandbox` 是 fs 侧路径围栏的**唯一实现**（`packages/tools/src/path.ts` 只是转发）。取舍见 `docs/adr/0008-sandbox-seam.md`。
- `packages/browser/` 是浏览器缝的容器：`browser` 是 Service Definition（`ctx.browser`，事件面 `browser/*`）、`browser-playwright` 是 Provider（`playwright-core`，可启动系统浏览器或经 CDP 附着到桌面端内嵌视图）、`tool-browser` 是 Consumer（模型可见的 `browser_*`）。取舍见 `docs/adr/0012-agent-browser.md`。
- `packages/session`：JSONL Session 持久化与重建不变量。
- `packages/cli`：CLI、配置、工作区和 Web server 组装层；`packages/coding-agent`：coding session 的 plan、skills、MCP 与 slash commands。
- `apps/web`：React/Vite 本地 UI；`src/`：根包的公开聚合导出。
- `apps/desktop`: 客户端实现

## 界面设计

- **所有前端开发（`apps/web`、`apps/desktop` 渲染层）都以 `docs/design/tnega-design.md` 为准。** 动手前按其 §0 的对照表读相关章节，提交前过一遍其 §11 清单；要改变设计时，在同一次改动里先改规范再改代码。天气状态语言见 `docs/design/weather-language.md`。
- 外观分两个轴：`data-theme`（浅 / 深）与 `data-palette`（Sky / Sand / Forest / Graphite）；信息显示偏好（密度、字号、对话宽度）也是根元素属性，见 `apps/web/src/lib/display.ts` 与规范 §6。组件只用 token，不读这些偏好再分支。
- 颜色只来自 `apps/web/src/styles/tokens.css`，组件不写裸色值；字号只用 `--text-*`、控件与行高只用密度 token。每个调色板的深浅两份同步修改，并通过 `apps/web/src/styles/contrast.test.ts` 的对比度底线（正文 ≥7:1，所有文字角色在所有面上 ≥4.5:1）。
- Agent 的状态用天气表达，一种天气只有一个含义（见 `apps/web/src/lib/weather.ts`）；新增状态先归入已有天气，不给同一天气赋第二个含义；动效遵循 `prefers-reduced-motion`。
- 标识是「带眼睛的云」（与协调者头像同形）：改标志时同步 `--brand-cloud` / `--brand-eyes`、favicon 与 `apps/desktop/build/icon.svg`，并用 `apps/desktop/scripts/render-icon.mjs` 重新生成安装包图标。
- 文件、改动、终端、浏览器与从对话打开的文档都放在右侧**工作台**（`apps/web/src/components/workbench/`），共用「标签栏 → 工具栏行 → 圆角卡片」的形状（见设计规范 5.3）；新增此类能力时加成工作台的工具或文档标签，不再新开抽屉。
- Agent 浏览器在两端都显示在工作台的 Browser 工具里（桌面原生视图 / Web 端 screencast），不弹独立窗口。

## 设计不变量

- 插件注册必须归属于其 Fiber；dispose 后效果按逆序撤销，且不能残留服务、事件监听或子进程。
- 同一作用域的同名服务应明确失败；必需服务写入 `inject`，可选服务通过 `ctx.get()` 取得。
- 能力缝的角色分工与依赖方向见 `docs/adr/0006-capability-seams.md`：Provider 与 Consumer 只依赖 Service Definition，两者互不依赖；Provider 的挑选属于 composition 层，Consumer 不得 import 或枚举具体 Provider。工具输出溢出缝的取舍见 `docs/adr/0007-tool-output-spill.md`，沙箱缝的取舍见 `docs/adr/0008-sandbox-seam.md`。
- 沙箱只限制**文件写**，且必须 fail closed：宿主上没有可用机制时抛 `SANDBOX_UNAVAILABLE`，禁止回退到非受限执行。`bypass` 是「不要沙箱」而不是更宽的策略。
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

## 发布

- 发布、打包或排查应用内更新时，先阅读 `docs/publish/README.md`，获取版本、验证、npm / GitHub 发布与更新源相关事宜。
- 用户可见功能、修复或兼容性变化，在同次改动中及时更新 `CHANGELOG.md` 的 Unreleased；发布前以相邻实际 tag 的完整差集核对，包含合并分支和版本跳号期间的更新。
- 可独立验收的功能或修复立即用 Conventional Commits 自主提交，主题 ≤72 字符，只包含相关改动。发布颗粒度大于 commit：多个新功能稳定并通过必要验证后才组成发布批次。
- 第三位补丁号可自主确定与增长；第一位主版本号、第二位次版本号须由用户确定。预览版使用 `x.y.z-beta.N`，稳定后发布同一目标版本 `x.y.z`。

# PTC 与会话提问工具

**Goal:** 在 `codex/ptc-question-tools` 上提供 QuickJS 程序化工具调用与独立提问插件，并接入现有会话界面。

**Architecture:** PTC 的 Definition、QuickJS Provider 与 `run_code` Consumer 分离。程序只能调用注册工具，子调用沿用工具验证、审批、取消与结果处理。只有外层调用进入模型工具历史；子调用作为带父调用标识的 Session 元数据记录。Question 服务持久化请求和回答，阻塞模式返回工具结果，非阻塞模式返回 pending 并将用户提交转为 durable steer；空闲时继续后续 Agent Run。

**Tech Stack:** TypeScript strict、Cordis 风格插件、Pi 独立 CodeMode/QuickJS WASM、React、现有 JSONL Session、Vitest。

## 全局约束

- 不提供直接文件、网络、子进程接口；这些能力只通过已有工具与权限管线。
- 不重复执行失败脚本；递归 `run_code` 禁止，取消与 dispose 不遗留 Worker 或等待。
- 问题正文和选项可空，始终有自由输入；默认选择不是用户回答。
- 阻塞回答通过工具结果恢复；非阻塞回答在提交时进入 inbox，不能在后台结束后丢失。
- 回答按 Session/Agent 隔离；重复提交只有第一次有效。重启后的非阻塞请求可恢复，失去执行者的阻塞请求不能伪装为仍在等待。
- 不改变现有权限策略、总结折叠或用户未提交的 `.pnpm-store/`。

## Task 1: PTC 插件

创建 `packages/ptc-runtime`、`packages/ptc-runtime-quickjs`、`packages/tool-ptc`，先测试工具管线、隔离、递归拒绝、取消和错误，再实现。提供 native/both/ptc 模型工具面，默认 both。公开入口和构建需携带 Worker/WASM。验证包测试、类型检查和真实打包入口，提交 `feat(ptc): add QuickJS programmatic tool calls`。

## Task 2: Question 插件

创建 `packages/user-questions`、`packages/tool-question`。测试阻塞/非阻塞、合法选项、自由输入、空问题、跨会话拒绝、重复回答、取消和 durable 恢复。提供 opened/answered/cancelled 元数据及待回答查询，提交 `feat(question): add durable user question tools`。

## Task 3: 产品组合与 UI

CLI/Web runtime 组合插件并提供查询、回答端点。运行中 steer，空闲手动流式 Agent 的后续工作必须实际 drain，避免只排队。沿用 composer/卡片风格，显示选项、自由输入、等待状态与提交错误，待回答问题不能被总结折叠隐藏。覆盖 HTTP 会话隔离、阻塞恢复、非阻塞延迟回答和组件交互；运行对应测试、typecheck、lint、build、package 检查，提交 `feat(web): integrate PTC and user questions`。

## 验收与兼容性

旧 Session 没有新元数据时行为保持；新元数据不参与模型/权限配置折叠。PTC 使用 MIT 的 Pi 独立库，不引入 Pi Agent。检查构建后真实 QuickJS 执行以及 Desktop 资源布局。最终说明分支、提交、验证结果和与初步策略的调整。

## 执行结果

- PTC 三角色与 question 两个包完成，独立提交 `7f9a6c1` 与 `9572105`。
- 新旧 Web Run 都使用 durable steer；空闲时通过原 SSE 通道 drain，保留工具审批。运行时创建按 Session 锁定，首次提交先持久化，再幂等投递，最后结算，避免并发重复及写队列失败后的丢失。
- 自定义 AgentDefinition 默认保留 native 工具面；普通 CLI/Web 默认 both。PTC 子调用在工具卡片内展开，问题卡片位于 composer 上方，独立于总结折叠。
- 已通过：question 9 项、PTC 12 项、HTTP question 5 项；相关前端、权限/profile/runtime/summary 回归；公开入口与独立复制运行资源 9 项；桌面打包布局测试。
- `pnpm typecheck`、Web typecheck、`pnpm lint` 与最终 `pnpm build` 通过。Worker/WASM 已进入 dist，独立目录无项目依赖也可运行；Node 最低版本更新为 22.19.0。
- 独立审查发现的三个队列/并发/结算问题已修复并复审。原有 `.pnpm-store/` 保留，不纳入提交。

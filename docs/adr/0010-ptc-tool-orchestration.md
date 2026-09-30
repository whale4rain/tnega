# PTC / CodeMode：QuickJS 编排与原有工具管线

> 状态：当前
> 取代关系：无；产品默认 both 的早期实现已由二选一设置取代
> 当前实现：`packages/ptc-runtime/README.md`、`packages/ptc-runtime-quickjs/README.md`、`packages/tool-ptc/README.md`、`packages/cli/README.md`

## 背景

CodeMode 与 PTC 都让模型编写程序组合工具调用。此项目不采用 DSH Node Provider 直接开放文件、网络和子进程的路线，只选择程序编排已有工具。QuickJS 是执行模型代码的底座，不是新的宿主权限入口。

对照 DSH/pi 时区分两件事：子调用是否回到原工具处理流程，以及每个子调用是否写成模型可见的 tool 消息。本项目保留原工具流程，但子调用写审计 meta；模型接收外层 `run_code` 的结果，不为子调用构造孤立 tool 消息。

## 决策

- `ptc-runtime` 定义服务，`ptc-runtime-quickjs` 是 Provider，`tool-ptc` 是 Consumer；Provider 选择属于 composition，Consumer 不依赖 QuickJS 实现。
- 使用独立 MIT 库 `@earendil-works/pi-codemode@0.99.1`，无需接入 Pi Agent runtime。每次 fresh worker/VM，不保留跨调用 store/load。
- VM 没有直接 filesystem、fetch、process、require/import 或定时器；宿主操作只能通过注册 bindings 回到 ToolsService 校验、审批、执行、输出处理。QuickJS 隔离不代替工具的 OS Sandbox。
- 产品配置 `codeMode` 为布尔值，默认 false。关闭只暴露原生工具，不注册 run_code；开启只暴露 run_code，拒绝直接原生 dispatch，但允许有 parent 身份的子调用。底层库的 both 仅保留兼容，不是设置选项。CLI、Web resident/单次运行、Project/Thread 使用一致配置，签名变化使下一次运行重建运行时。
- 脚本调用 `await tools[name](input)`；工具不是全局函数。`ALL_TOOLS` 是 `{name, description}` 清单，input schema 嵌在 description。陌生工具先发现、检查 schema/小结果，不猜返回形状。
- promise 直接返回工具 output，不增加通用 `{ok, output, value}` 包装。json stringify/now 是字符串；list_dir 是数组，目录 type 为 directory；失败抛异常，可 try/catch。
- 初版将内部调用串行化，包括 Promise.all，以保持审批顺序、避免修改竞争；这是安全/可预测性的取舍，不承诺并行提速。不自动重试整段脚本，已完成副作用不会回滚，重试应只针对失败操作。

### 限额、生命周期与事件

默认脚本期限 300 秒（包括审批和阻塞问题等待）、VM 内存 64 MiB、100 次调用、64,000 输出字符。worker 还有 1,024 输出项、64,000 字符序列化调用输入等硬上限；具体可配置范围以 Provider README 为准。取消/dispose 终止 worker、取消宿主子调用并等待清理；取消不能撤销已完成操作。

每个子调用记录 `ptc/dispatch-start` 和 `ptc/dispatch`，包含 parent/child ID。它们是 durable 审计，不是独立模型 tool-result。只用 Session 的 renderToolResult 做文本/大小处理，保留溢出定位信息。

Web 每次运行安装观察 Fiber，在审批前发送子调用开始，完成后发送结果，并在运行结束 dispose。`ptc/dispatch` Stream Event 只推进显示；最终状态重新从 Session 重建，不能依赖 live 事件恢复模型历史。

界面默认展开运行中的 CodeMode，显示 raw JavaScript、子工具名称/状态/数量；text 输出分块，return value 单列。结束后的 Run Summary 折叠保持原语义。

## 后果

一次 run_code 可以产生多个独立审批；不能批准外层编排后跳过 shell 子审批。真实问题工具仍可通过 CodeMode 调用，但受脚本总期限限制。worker/WASM 必须随发布产物部署；`scripts/build.mjs` 构建 ptc-worker.js 并复制 quickjs.wasm。Node 最低版本为 22.19.0。

本分支还提供独立 question 插件：阻塞答案回到原工具调用；非阻塞返回 pending，最终提交进入 durable steer，运行结束后的答案排队续跑。稳定 ID、first-answer-wins、自由输入、可跳过及取消语义参见 `packages/user-questions/README.md`。它不是绕过审批的授权通道。

## 验证

真实 VM 隔离、取消、期限/输出边界：`packages/ptc-runtime-quickjs/test/runtime.test.ts`。工具审批/身份/串行顺序/失败与结束传播：`packages/tool-ptc/test/tool-ptc.test.ts`。设置切换及 live 显示：`packages/cli/test/code-mode-web.test.ts`、`ptc-observation.test.ts`、Web Timeline 测试。打包入口：`test/publish.test.ts`。故障细节见 [修复记录](../fix/2026-09-30-review-ptc.md)。

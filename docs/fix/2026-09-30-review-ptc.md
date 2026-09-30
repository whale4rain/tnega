# Review / PTC 实现与故障修复记录（2026-09-30）

> 状态：当前
> 取代关系：无；当前策略以 ADR 0009/0010 为准，下面旧评分只用于追溯
> 当前实现：`docs/adr/0009-automatic-approval.md`、`docs/adr/0010-ptc-tool-orchestration.md` 和各包 README

## 目的与环境

记录本次会话的审批、PTC 取舍及修复，避免将早期方案、旧进程输出和当前代码混为一谈。代码基线 main 为 `3f6e861`，功能分支 `codex/ptc-question-tools`，实现/修复至 `8eac8a5`。环境为 Windows、Node 22.22.2、pnpm 11.19.0。现场 Session 位于 `D:/task/tmp/.tnega/sessions/`；文档不复制凭据或完整工具正文。

## 现象、根因与修复

| 现象 | 查明原因 | 修复与验证依据 |
| --- | --- | --- |
| 审批模型影响对话模型，旧 Session 出现请求异常 | approval 审计字段与会话配置解析职责混淆会污染对话路由；新会话正常不代表旧历史可直接复用 | 配置只解析对应事件；`approval/*` 审计与 model/mode 分离，fork 也保持隔离。`packages/cli/test/approval-config.test.ts` 覆盖；不能把所有 HTTP 400 都归因于同一原因 |
| 低风险仍 ask、历史一截断就 ask | 风险类别、置信度和冲突是不同门槛；早期曾把截断视为人工条件 | 删除截断即 ask，先采用 0.9，用户后调整至 0.85。低/中风险冲突门槛保留 0.2/0.05；reason 来自本地决策，不要求 Jev 生成文字 |
| PTC read_file is not defined | 脚本误把工具当作全局函数 | 提示明确 tools.read_file；ALL_TOOLS 只用于发现，schema 位于 description。`fa7f329` |
| JSON round-trip 报 value must be a string，项目统计全空 | 模型猜测 stringify 返回 `.value`，目录类型猜为 dir | 文案明确直接返回字符串/数组及 directory，不加兼容包装掩盖误用。原生工具与真实 VM/Consumer 测试 |
| PTC shell 仿佛没调用 Auto | 现场新增 40 次 shell 全部有 Jev 审查，28 allow / 12 ask | 3 次仅置信度不足、6 次仅冲突超限、3 次二者均有；这是旧输入/门槛下的观察，不是新策略效果。例如 echo probe 为 low、confidence 0.69，echo hi 为 low、confidence 0.96；无文本解释，不能断言模型内部原因 |
| echo 等简单调用评分不稳定 | 审批历史包含整个 PTC 源码和旧任务；风险定义还夹带任务匹配要求 | 移除整段 run_code，使用当前任务真实子调用配对；优先用户要求，历史写文件正文摘要，风险与冲突分开。`baee908` |
| run_code 难读，审批等待时看不到内部工具 | 通用 JSON 渲染产生转义；子调用原先只在结束后 reload Session 显示 | JS 展示、分块 text/value、子工具状态；每次运行观察 Fiber 发送 live 增量并清理。`8820668`、`ffb4c41` |
| Web 审批数字提示难懂、allow 消息刷屏 | 将审计 reason 原样用于显示，allow 也构造消息 | ask/deny 使用简短中文，allow 不展示；审计仍留存。`e460ff7`、`d13ab56` |
| CodeMode 设置看似保存但未落盘，新日志仍 below 0.9 | 正在运行的是 13:54 启动的旧 pnpm tnega web，未加载后续源码；旧 PUT 忽略新字段 | 正确新后端开关往返已由 resident/单次运行 HTTP 测试覆盖。新增响应校验，不确认 codeMode 就报错，不能静默关窗。`537066d`、`0b45773`；构建/刷新界面不会重新加载进程里的模块，需重启后端 |
| 长命令更常转人工 | 旧日志复杂 Go probe 同时触发置信度和冲突门槛，且涉及临时目录；无法据此证明单纯长度致因 | 先加载新输入/prompt，不继续盲降门槛。增加逐步骤影响判断，排除长度/转义/编译失败本身；临时路径仍检查边界。`8eac8a5` |

### 总结插件与问题工具的相关取舍

Run Summary 是独立展示插件：成功 Agent Run 的最后一条完整、无工具调用的模型答复保存为 `run/summary`。它不额外调用模型，不改模型历史；失败、取消或没有完整最终答复时不折叠。PTC 子调用仍归属于外层过程，问题卡片位于过程折叠之外。

question 采用稳定请求/问题 ID、结构化选项与始终可用的自由文本。非阻塞返回 pending，答案先持久化 submitted，再幂等投递 durable steer，最后 answered；不能仅写回答 meta 后依赖一次性 live 通知。阻塞答案只回到原工具，避免重复 user 消息；没有运行时等待者的旧阻塞问题取消，非阻塞问题可以恢复。Web 会把运行结束后的答案排队续跑，并避免与尚未结束的旧 SSE 重叠。

## 离线重建结果与限制

对 `f42a4fbe-5948-4079-b70f-025873dac016.jsonl` 的事件前缀用实际 Session 投影和 buildReviewContext 重建：

| 审批事件 seq | 原历史证据字符数 | 修正后 | 修正后是否预算截断 |
| --- | ---: | ---: | --- |
| 2214（echo probe） | 20,606 | 1,833 | 否 |
| 2327 | 23,961 | 4,816 | 否 |
| 2551 | 23,957 | 14,338 | 否 |

修正后这三份证据没有 run_code 源码，仍保留 4 条可信用户请求。字符数仅统计 evidence JSON，不包含待审 action、额外约束和 questions prompt。没有重新向 Jev 发送这批历史请求，不能据离线缩减声称模型评分或自动通过率已经提高。新版实际运行需要另行积累样本。

## 验证与遗留项

本轮已用相关测试验证真实 QuickJS、工具审批/串行化、问题持久化/答案投递、CodeMode 设置两种运行路径、live timeline、保存响应校验、Provider 评分及配置隔离。合并前记录的命令及结果在本文后续验证段更新。

已知独立限制：早期一次 tools/builtins 的 HTTP mock 测试失败；对应 JSON/文件/计算测试通过，未为了该失败顺手改网络能力。没有宣称全仓测试全绿。默认串行化、300 秒脚本总期限和非持久 VM 是明确取舍；超过限制、Jev 不确定或真实冲突仍会转人工。旧 JSONL 审计不重算，服务升级不修改用户原始 Session。


### 合并前验证（2026-09-30）

- `pnpm typecheck`：通过。
- `pnpm exec tsc -p apps/web/tsconfig.json`：通过。
- 相关回归与发布检查：25 个测试文件、170 项测试通过（62.23 秒）。选择范围为审批 Providers/Consumer、PTC Runtime/Consumer、问题服务/工具、Run Summary、CLI 审批/权限/Agent Runtime/问题与 CodeMode HTTP、Web Timeline/Settings/Conversation/QuestionPanel/Config API，以及 `test/publish.test.ts`、`apps/desktop/test/package.test.ts`。
- 发布测试包含重新构建及脱离工作区依赖的 QuickJS worker/WASM 运行验证；本次未重新生成桌面安装包。
- `git diff --check` 和新增文档本地链接校验：通过。
- 测试有既有 exports/sourcemap 警告，但退出码为 0。未声称运行全仓测试；既有无关问题见上文。
- 合并前独立只读审查未发现可复现的 Important/Critical 问题。

可重跑主要测试组：

```powershell
pnpm test -- packages/auto-approval/test packages/approval-jev/test packages/approval-llm/test packages/approval-openai/test packages/ptc-runtime-quickjs/test packages/tool-ptc/test packages/user-questions/test packages/tool-question/test packages/run-summary/test packages/cli/test/approval-config.test.ts packages/cli/test/approval-api.test.ts packages/cli/test/permissions.test.ts packages/cli/test/code-mode-web.test.ts packages/cli/test/ptc-observation.test.ts packages/cli/test/questions-web.test.ts packages/cli/test/agent-runtime.test.ts apps/web/src/lib/config-api.test.ts apps/web/src/lib/timeline.test.ts apps/web/src/components/QuestionPanel.test.ts apps/web/src/components/Timeline.test.ts apps/web/src/components/SettingsDialog.test.ts apps/web/src/components/Conversation.test.ts test/publish.test.ts apps/desktop/test/package.test.ts
```

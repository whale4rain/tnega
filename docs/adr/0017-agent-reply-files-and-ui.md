# 0017 答复里的文件与 Agent 界面：send_file、show_ui 与 `[ui-action]` 消息

> 状态：当前
> 取代关系：无
> 当前实现：`packages/reply/README.md`、`packages/reply/a2ui/README.md`、`packages/reply/tool-ui/README.md`、`packages/reply/tool-send-file/README.md`

日期：2026-11-03

## 背景

Agent 的答复只有文字：它做出的图表、报告只能写成路径让人自己去找，需要人做选择时只能列文字选项。用户要求答复能带图片与文件，并支持 A2UI（Agent 渲染界面），第一版保持简单、可靠。

## 决策

- **两个模型可见工具，放在回复域 `packages/reply/`**：`send_file`（`tool-send-file`）与 `show_ui`（`tool-ui`）。都是 Consumer，只在自己的 Fiber 上注册工具；由 `packages/runtime` 的 `capability:reply`（RuntimeSpec / AgentRuntimeOptions 的 `reply`）挂载，Web / 桌面宿主打开，`tnega run` 与 Project 线程暂不挂。
- **工具调用本身就是记录**：`send_file` 的结果是 `{ sent: [{ path, name, size, kind }] }`，`show_ui` 的界面就是调用参数。文件内容不读进模型上下文，客户端从工作区（`/api/files`）读字节、从参数渲染界面，所以重放与实时一致，不新增 Session 事件类型。`send_file` 的路径不论权限都限制在工作区内（客户端只能从那里读），因此两个工具在审批宿主里属于始终放行。
- **A2UI 子集，一次发送**：`@tnega/a2ui` 定义组件目录（`Column` / `Row` / `Card` / `Text` / `Image` / `Divider` / `TextField` / `CheckBox` / `ChoicePicker` / `Button`）、扁平组件表 + `root`、一层的数据模型（`path: "/key"`）。不做 A2UI 的流式 `surfaceUpdate` / `dataModelUpdate`、嵌套数据与自定义目录。也接受 A2UI 原文的 `literalString`、`explicitList`、`usageHint` 写法。工具与客户端共用同一个 `parseSurface`。
- **按钮回传是一条普通用户消息**，格式为持久化约定：

  ```text
  [ui-action] {"surface":"<show_ui 的 callId>","action":"submit","label":"Continue","values":{"plan":"pro"}}
  ```

  一行前缀 `A2UI_ACTION_PREFIX` 加 JSON（`formatAction` / `parseAction`）。模型直接读它；Web 时间线与 TUI 用 `parseAction` 把它画成「按了什么 + 各项取值」，并据此把对应界面显示为已回答（只看紧随该回合的那条用户消息）。不是这个格式的文本照常显示。
- **带按钮的界面结束本回合**（工具在执行时设置 `concludesTurn`），回答作为下一条用户消息到达；只有最新且空闲的回合里的界面可以填。

## 后果

- 旧 Session 不受影响：没有新事件类型，`[ui-action]` 只是用户消息文本。
- 这个格式一旦写进 Session 就要一直能读：以后改格式必须让 `parseAction` 继续认得旧形状（或新增前缀），不能就地改字段名。
- 不认识这两个工具的客户端只会看到普通的工具步骤与一条带前缀的用户消息，不会出错。
- Project 线程、无界面的 `tnega run` 没有这两个工具；要给它们时再决定界面落在哪里。

## 验证

- `packages/reply/*/test`：解析与报错文案、`[ui-action]` 往返、工具注册 / 结束回合 / dispose、工作区围栏。
- `packages/client/test/reply.test.ts`、`apps/web/src/components/ReplyOutputs.test.ts`：提取、渲染、提交一次、已回答与过期的锁定。
- 2026-11-03 用 DeepSeek（`deepseek-v4-flash`）在真实 Web 宿主上端到端跑通：发送 SVG 图与 Markdown 文件，展示表单、提交、Agent 读到取值并作答。

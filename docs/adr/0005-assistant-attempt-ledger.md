# Session 保存未产生模型消息的 assistant attempt

模型请求可能在已返回部分内容后失败、重试或取消。只保留 `assistant/message`
会丢失这些尝试，保存为模型消息又会把未提交输出带进后续请求。对齐 DSH 的终态
attempt 语义，Session v8 增加 log-only `assistant/attempt`，payload 为
`{ turn, step, stream }`，在对应 step 尚未结束时提交。

`stream` 是按接收顺序排列的 Session 自有 `AssistantStreamRecord[]`：每条
`{ time, chunk }` 保留时间与分块边界。`chunk` 覆盖当前归一化消息与工具调用
流事件，以及保存序列化错误的 `stream_error`。调用方先归一化 provider 数据；
Session 不引入 Agent 或 provider 依赖。空 stream 表示尝试未收到任何分块，
终态事件本身即可表示结算，无需伪造 stop 分块。

该事件只进入 raw 日志，`deriveMessages()`、surface 与上下文 token 估算都忽略
它。一次 step 可有多个终态 attempt；Agent 生命周期内的 attempt id/revision
只用于实时帧关联，不成为持久化 Session 身份。成功提交消息的尝试仍以
`assistant/message` 表达。

`runInvariants()` 校验 attempt 的 turn/step 归属和记录形状。此格式变更把
`SESSION_FORMAT_VERSION` 从 7 提升到 8；`init()` 拒绝 v7 及更早日志并保留
原始文件。预发布期明确不做原地迁移，使用者保留旧日志归档并创建新 Session。
这一选择避免静默改写历史或将旧格式误认为具备新的审计事实。

# Approval Review

Service Definition：`ApprovalReviewer` 提供 `ctx.approvalReviewer.review(request)`。
request 包含准确的 action、workspace、带来源且有界的 evidence 与 cancellation signal。
结果为 `allow`、`deny` 或 `ask`，附带理由与可选风险等级、Provider 和模型名称。

Provider 与 Consumer 均只依赖此定义。Provider 的 `allow` 不是沙箱豁免；执行仍经过工具 policy 与 Sandbox。
同作用域重复服务应失败，dispose 后移除服务并取消进行中的审查。

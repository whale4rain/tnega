# LLM Approval Provider

`LlmApprovalReviewer` 使用当前对话的 LLMAdapter，或 composition 层提供的独立 adapter resolver。
审查请求使用隔离的 system policy、结构化证据与准确 action，工具列表为空，输出上限 512 tokens。
只接受完成的严格 JSON 决策；高风险 allow、无效输出、截断证据、超时或取消回退 `ask`。
默认超时 20 秒；Fiber dispose 取消进行中的请求，不写入对话模型历史。

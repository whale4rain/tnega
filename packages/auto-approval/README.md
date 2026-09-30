# Auto Approval

`autoApproval` 是审批 Consumer，只依赖 `approval-review` 定义，不选择具体 Provider。
composition 层挂载 conversation LLM、configured model route、Jev 或 OpenAI Provider。
插件与 Fiber 生命周期绑定，审查的是原始工具输入与 schema，不执行命令。

Web/Desktop 的 composer 可选择 **Ask me** 或 **Auto review**，Settings 中配置审批 Provider。
权限预设与审批模式独立。低权限子 Agent 不会自动使用父 Agent 的提权策略。
CLI 的 System Config 也可声明：

```json
{
  "approvalReview": {
    "provider": "jev",
    "defaultMode": "auto",
    "model": "jev-latest",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "baseUrl": "https://api.typesafe.ai/v1",
    "timeoutMs": 20000
  }
}
```

`provider` 支持 `conversation`（默认）、`model`（使用 `modelId` 指向已有模型路由）、
`jev` 与 `openai`。OpenAI 默认模型为可配置的 `gpt-6.1-sol`，默认端点
`https://api.openai.com/v1`，使用 `OPENAI_API_KEY`。专用 Provider 的密钥与对话模型独立，
Jev 地址也接受完整的 `https://api.typesafe.ai/v1/systemone`，不会重复追加路径。
Web 配置响应只返回 `apiKeySet`。切换 Provider 会清除上一家的配置，需重新配置密钥。

参考 [DSH auto-review](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/auto-review)：
保留用户请求、带来源的 Agent 请求和当前任务的工具调用事实，不传系统消息、assistant 推理或工具返回正文。
用户证据优先占用预算；历史任务的工具调用和整个 `run_code` 脚本不进入审查。
PTC 使用当前用户请求之后持久化的 `ptc/dispatch-start` 与 `ptc/dispatch` 配对记录，
提供准确工具输入、成功/失败状态及 shell 退出码；未完成的脚本步骤不作为已执行事实。
历史 `write_file` 正文仅保留字符数、路径及追加标记，避免正文污染审批上下文；当前待审批 action 始终使用原始完整输入。
这些事实不能授予用户授权。风险分类只看当前操作本身的影响，任务与约束匹配由冲突判断处理。
Project 中的 `box:` 消息依据可信 Box Envelope 的 sender 分类；其他有名消息保守视为 Agent。
上下文最多 24,000 字符，原始 action 最多 16,000 字符，项目约束最多 8,000 字符。
每条证据完整保留，不截断命令。省略旧历史时记录 `contextTruncated`，该标记不会强制回退人工审批。
上下文超限、无效 JSON、模型拒答、凭据缺失、超时、取消或切回 manual 均回退人工审批。
每次实际审查以 Session `meta` 的 `approval/review` 记录保存结果与理由。
Jev 的新审查只使用风险、风险置信度和冲突概率，保存对应 `scores`，不再询问任务匹配度或精确授权；风险置信度门槛为 0.85，低/中风险冲突门槛分别为 0.2/0.05。Auto 覆盖所有工具与 shell，包括依赖安装和 Git 提交。
回退理由列出未满足的评分与阈值，已有审计记录无需迁移。

Session 使用 `approval/mode` 元数据保存模式，fork 保留模式与历史审查记录。
现有 JSONL 格式兼容，旧 Session 默认为 manual；升级不会修改历史内容。

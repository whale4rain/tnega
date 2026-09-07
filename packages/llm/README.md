# `@tnega/llm`

模型接入 seam。能力表携带价格元数据；key 只从环境变量或 `.tnega` 配置读取，
绝不进入代码或仓库文件。

## 协议适配器

| 适配器 | 协议 | 默认模型 |
|---|---|---|
| `openaiCompatAdapter` | OpenAI compatible `chat/completions` | `deepseek-v4-flash` |
| `anthropicMessagesAdapter` | Anthropic Messages API | `minimax-m3` |

`createLlmAdapter` 按模型表选择协议，未知模型回退 OpenAI。

## 流式

`LLMAdapter.stream()` 返回归一化事件流：`message_start` / `message_delta` /
`message_stop` / `toolcall_start` / `toolcall_end`。agent 层把 `message_delta` 落成
durable `assistant/chunk`，并在 `llm/stream` waterfall 上让插件可改写最终请求。

## 超时与重试

`timeoutMs` / `maxRetries` / `retryDelayMs` 配置。默认 120s、最多 2 次重试、指数退避。
只对网络错误 / 408 / 425 / 429 / 5xx 重试；401/403 等 4xx 不重试；外部 abort 立即停止。

## 错误语义

网络失败、非 2xx、非法 JSON 统一包装为 `OpenAICompatibleError`；HTTP 429/5xx 在
`listModels` 与 adapter 上做结构化分类。

## 测试

`packages/llm/test/`：请求构造、SSE 解析、tool calls、超时/重试矩阵、abort、
key 不泄露。真实冒烟见 `test/deepseek*.smoke.test.ts`。

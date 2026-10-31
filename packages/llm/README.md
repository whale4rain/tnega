# `@tnega/llm`

模型接入 seam。能力表携带价格元数据；key 只从环境变量或 `.tnega` 配置读取，
绝不进入代码或仓库文件。

## 协议适配器

| 适配器 | 协议 | 默认模型 |
|---|---|---|
| `openaiCompatAdapter` | OpenAI compatible `chat/completions` | `deepseek-v4-flash` |
| `anthropicMessagesAdapter` | Anthropic Messages API | `minimax-m3` |

`createLlmAdapter` 按模型表选择协议，未知模型回退 OpenAI。
Responses 适配器接受可选 `fetch` 传输函数，由 composition 层接入宿主网络配置；
未配置时使用原生 fetch，其余协议的默认行为不变。
`modelCapabilities` 向配置与会话选择器提供协议及思考强度能力。支持的模型可设置
`reasoningEffort`（low / medium / high）：OpenAI compatible 使用
`reasoning_effort`，Anthropic Messages 使用 adaptive thinking 和
`output_config.effort`。其他模型维持提供商默认行为。

## 流式

`LLMAdapter.stream()` 返回归一化事件流：`message_start` / `message_delta` /
`message_stop` / `toolcall_start` / `toolcall_end`。agent 层把 `message_delta` 落成
durable `assistant/chunk`，并在 `llm/stream` waterfall 上让插件可改写最终请求。

## 图片：Files API

图片默认**不进请求体**。`prepareWireImages` 把每张图的字节按 SHA-256 去重，
上传到路由的 Files API 一次（OpenAI 形状 `POST <base>/files`，Anthropic 形状
`POST <base>/v1/files` 并带 `files-api-2025-04-14` beta），之后只用 file id：

| 协议 | 引用形状 |
|---|---|
| chat/completions | `{ "type": "file", "file_id": "…" }` |
| responses | `{ "type": "input_image", "file_id": "…" }` |
| anthropic messages | `{ "type": "image", "source": { "type": "file", "file_id": "…" } }` |

- multipart 的 `purpose` 默认 `vision`，被拒后改用 `user_data` 并记住该端点的选择
  （DeepSeek 只接受 `user_data`）。
- file id 按内容缓存并跨轮稳定，所以重复截图不会重复上传，prompt 前缀也不会因为
  图片字节重新编码而抖动。
- 端点没有 Files API（404/405/501）时记下来，之后直接走内联 base64，不再每轮试一次。
- `filesApi`: `auto`（默认）/ `off` / `required`（上传失败即报错，不回退内联）/ 
  `openai` / `anthropic`（强制形状）。`filesUrl` / `filesPurpose` 可覆盖端点与 purpose。

## Responses：服务端保存的对话

`store` + `previous_response_id` 让服务端保存历史，后续只发新增的轮次。适配器对每条
消息取指纹，只有当前历史是上次的严格前缀时才链式续写（压缩、编辑、图片窗口滑动都会
让它退回全量重发）；响应里 `store` 为 false 的路由（DeepSeek 当前如此）自动关掉状态化，
之后一律全量。`stateful: false` 可强制关闭。

## 超时与重试

`timeoutMs` / `maxRetries` / `retryDelayMs` 配置。默认 120s、最多 2 次重试、指数退避。
只对网络错误 / 408 / 425 / 429 / 5xx 重试；401/403 等 4xx 不重试；外部 abort 立即停止。

## 错误语义

网络失败、非 2xx、非法 JSON 统一包装为 `OpenAICompatibleError`；HTTP 429/5xx 在
`listModels` 与 adapter 上做结构化分类。

## 测试

`packages/llm/test/`：请求构造、SSE 解析、tool calls、超时/重试矩阵、abort、
key 不泄露。真实冒烟见 `test/deepseek*.smoke.test.ts`。

import type { ReasoningEffort } from './models.js'

export interface LlmConfig {
  /** Responses transport; composition may supply a fetch that follows its network settings. */
  fetch?: typeof globalThis.fetch
  apiKey?: string
  /** Header used for API-key authentication with Anthropic-compatible providers. */
  apiKeyHeader?: 'x-api-key' | 'api-key'
  baseUrl?: string
  model?: string
  /**
   * Force the wire protocol instead of inferring it from the model catalog.
   * `responses` is the OpenAI Responses API (used for ChatGPT sign-in).
   */
  protocol?: 'anthropic' | 'openai' | 'responses'
  /** Headers resolved per request, for credentials that refresh (ChatGPT sign-in). */
  requestHeaders?: (signal?: AbortSignal) => Record<string, string> | Promise<Record<string, string>>
  /**
   * Responses API only: instructions to fall back to when the endpoint rejects
   * the conversation's own system prompt as `instructions` (the Codex backend
   * accepts only its own); the system prompt then travels as a developer message.
   */
  fallbackInstructions?: () => Promise<string>
  /** Undefined explicitly clears an inherited sampling setting. */
  temperature?: number | undefined
  reasoningEffort?: ReasoningEffort
  /** `off` skips hidden reasoning on routes known to support it (DeepSeek's own API); others ignore it. */
  reasoning?: 'off'
  /** Whether the model accepts images; defaults to the model-id heuristic. */
  vision?: boolean
  /** Most recent images sent per request; older ones become a text note. */
  maxImages?: number
  /**
   * How images reach the provider. `auto` (the default) uploads each unique
   * image to the route's Files API once and references it by id, so the request
   * body carries no base64. `off` keeps them inline, `required` fails the
   * request instead of falling back to an inline image, and `openai` /
   * `anthropic` force an upload shape regardless of protocol.
   */
  filesApi?: 'auto' | 'off' | 'required' | 'openai' | 'anthropic'
  /** Upload endpoint; defaults to `<baseUrl>/files` or `<baseUrl>/v1/files`. */
  filesUrl?: string
  /** Multipart `purpose`; defaults to `vision`, retried as `user_data` when rejected. */
  filesPurpose?: string
  /**
   * Responses API only: let the provider keep the conversation and send just
   * the new turns (`store` + `previous_response_id`). Turned off by itself the
   * first time a route reports it did not store the response.
   */
  stateful?: boolean
  /**
   * Responses API only: ask the provider to keep the response. `false`
   * disables server-side state (the ChatGPT backend requires it).
   */
  store?: boolean
  maxTokens?: number
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

export type OpenAICompatibleConfig = LlmConfig

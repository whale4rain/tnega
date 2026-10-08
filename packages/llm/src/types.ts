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
  /** Whether the model accepts images; defaults to the model-id heuristic. */
  vision?: boolean
  /** Most recent images sent per request; older ones become a text note. */
  maxImages?: number
  maxTokens?: number
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

export type OpenAICompatibleConfig = LlmConfig

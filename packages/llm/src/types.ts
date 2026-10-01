import type { ReasoningEffort } from './models.js'

export interface LlmConfig {
  apiKey?: string
  /** Header used for API-key authentication with Anthropic-compatible providers. */
  apiKeyHeader?: 'x-api-key' | 'api-key'
  baseUrl?: string
  model?: string
  /** Force the wire protocol instead of inferring it from the model catalog. */
  protocol?: 'anthropic' | 'openai'
  temperature?: number
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

export interface LlmConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

export type OpenAICompatibleConfig = LlmConfig

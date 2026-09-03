import { anthropicMessagesAdapter } from './anthropic-messages.js'
import { lookupModel } from './models.js'
import { openaiCompatAdapter } from './openai.js'
import type { LlmConfig } from './types.js'

export function createLlmAdapter(config: LlmConfig): ReturnType<typeof openaiCompatAdapter> {
  if (config.protocol === 'anthropic') {
    return anthropicMessagesAdapter(config)
  }
  if (config.protocol === 'openai') {
    return openaiCompatAdapter(config)
  }
  if (lookupModel(config.model)?.protocol === 'anthropic') {
    return anthropicMessagesAdapter(config)
  }
  return openaiCompatAdapter(config)
}

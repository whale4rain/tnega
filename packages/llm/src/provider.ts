import { anthropicMessagesAdapter } from './anthropic-messages.js'
import { openaiResponsesAdapter } from './openai-responses.js'
import { withImageFallback } from './images.js'
import { lookupModel } from './models.js'
import { openaiCompatAdapter } from './openai.js'
import type { LlmConfig } from './types.js'

export function createLlmAdapter(config: LlmConfig): ReturnType<typeof openaiCompatAdapter> {
  return withImageFallback(routeAdapter(config))
}

function routeAdapter(config: LlmConfig): ReturnType<typeof openaiCompatAdapter> {
  if (config.protocol === 'responses') {
    return openaiResponsesAdapter({ ...config, ...(config.requestHeaders ? { headers: config.requestHeaders } : {}) })
  }
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

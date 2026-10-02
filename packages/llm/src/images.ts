import type { LLMAdapter, LLMStreamEvent } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import { OpenAICompatibleError } from './errors.js'
import { prepareImages } from './shared.js'

/** A provider error that says, in so many words, that it cannot take images. */
export function isImageRejection(error: unknown): boolean {
  if (!(error instanceof OpenAICompatibleError)) return false
  if (error.status !== 400 && error.status !== 415 && error.status !== 422) return false
  return /image|vision|multimodal|multi-modal|image_url|unsupported content|content type/iu.test(`${error.message} ${error.detail ?? ''}`)
}

const withImages = (messages: readonly ModelMessage[]): boolean => messages.some(message => message.attachments?.length)

/**
 * Retry once without images when a provider rejects them, and keep sending
 * text-only notes from then on. Only requests that carry images are affected,
 * and a stream is retried only if it failed before yielding anything.
 */
export function withImageFallback(adapter: LLMAdapter): LLMAdapter {
  let textOnly = false
  const strip = (messages: readonly ModelMessage[]) => prepareImages(messages, { vision: false })
  const fallback: LLMAdapter = {
    async complete(messages, tools, options) {
      if (textOnly) return adapter.complete(strip(messages), tools, options)
      try {
        return await adapter.complete(messages, tools, options)
      } catch (error) {
        if (!withImages(messages) || !isImageRejection(error)) throw error
        textOnly = true
        return adapter.complete(strip(messages), tools, options)
      }
    },
  }
  const stream = adapter.stream?.bind(adapter)
  if (stream) {
    fallback.stream = async function* (messages, tools, options): AsyncGenerator<LLMStreamEvent, void, void> {
      if (textOnly) {
        yield* stream(strip(messages), tools, options)
        return
      }
      let yielded = false
      try {
        for await (const event of stream(messages, tools, options)) {
          yielded = true
          yield event
        }
      } catch (error) {
        if (yielded || !withImages(messages) || !isImageRejection(error)) throw error
        textOnly = true
        yield* stream(strip(messages), tools, options)
      }
    }
  }
  return fallback
}

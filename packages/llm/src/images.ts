import type { LLMAdapter, LLMStreamEvent } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import { OpenAICompatibleError } from './errors.js'
import { imageKey } from './files.js'
import { prepareImages } from './shared.js'

/**
 * A provider error that says the route cannot take images at all.
 *
 * The distinction matters. A rejected upload ("you have uploaded an unsupported
 * image"), a file id this account does not own, or an image the model finds too
 * large are problems with one image; answering them by going text-only would
 * take vision away from every later turn of the Session. Only an error about
 * the model's own input means the route will never take an image.
 */
export function isImageRejection(error: unknown): boolean {
  if (!(error instanceof OpenAICompatibleError)) return false
  if (error.status !== 400 && error.status !== 415 && error.status !== 422) return false
  const detail = `${error.message} ${error.detail ?? ''}`
  // About one image: the next well-formed one may well work.
  if (/uploaded an unsupported image|unsupported image|invalid image|image (?:format|is valid|dimensions|size)|too large|file_?ids?|'vision' purpose|purpose is not supported/iu.test(detail)) {
    return false
  }
  // About the model's input: this route will never take an image.
  return /does not support (?:image|vision|multimodal|multi-modal)|(?:image|vision)(?: input)? (?:is )?not supported|cannot (?:read|see|process|accept) (?:image|images)|not (?:a )?multimodal|multi-?modal input|image_url (?:is )?not supported/iu.test(detail)
}

const withImages = (messages: readonly ModelMessage[]): boolean => messages.some(message => message.attachments?.length)

/** Identity of the images a request carries, so a later, different image may try again. */
function imagePrint(messages: readonly ModelMessage[]): string {
  return messages.flatMap(message => (message.attachments ?? []).map(imageKey)).join(',')
}

/**
 * Retry once without images when a route rejects them, and remember which
 * images taught us that: the same images keep travelling as text notes, while a
 * different image gets one more attempt. Only a rejection about the model's own
 * input is treated this way (see {@link isImageRejection}), so one malformed
 * image cannot blind the rest of the Session.
 *
 * Only requests that carry images are affected, and a stream is retried only if
 * it failed before yielding anything.
 */
export function withImageFallback(adapter: LLMAdapter): LLMAdapter {
  /** Images that were refused as input; `undefined` while the route takes them. */
  let rejected: string | undefined
  const strip = (messages: readonly ModelMessage[]) => prepareImages(messages, { vision: false })
  const known = (messages: readonly ModelMessage[]): boolean =>
    rejected !== undefined && imagePrint(messages) === rejected

  const fallback: LLMAdapter = {
    async complete(messages, tools, options) {
      if (known(messages)) return adapter.complete(strip(messages), tools, options)
      try {
        const completion = await adapter.complete(messages, tools, options)
        // Images went through, so an earlier refusal no longer stands.
        if (rejected !== undefined && withImages(messages)) rejected = undefined
        return completion
      } catch (error) {
        if (!withImages(messages) || !isImageRejection(error)) throw error
        rejected = imagePrint(messages)
        return adapter.complete(strip(messages), tools, options)
      }
    },
  }
  const stream = adapter.stream?.bind(adapter)
  if (stream) {
    fallback.stream = async function* (messages, tools, options): AsyncGenerator<LLMStreamEvent, void, void> {
      if (known(messages)) {
        yield* stream(strip(messages), tools, options)
        return
      }
      let yielded = false
      try {
        for await (const event of stream(messages, tools, options)) {
          yielded = true
          yield event
        }
        if (rejected !== undefined && withImages(messages)) rejected = undefined
      } catch (error) {
        if (yielded || !withImages(messages) || !isImageRejection(error)) throw error
        rejected = imagePrint(messages)
        yield* stream(strip(messages), tools, options)
      }
    }
  }
  return fallback
}

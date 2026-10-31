import { createHash } from 'node:crypto'
import type { ModelAttachment, ModelMessage } from '@tnega/session'
import { OpenAICompatibleError } from './errors.js'
import { assertOk, normalizeBaseUrl, prepareImages } from './shared.js'
import type { LlmConfig } from './types.js'

/** Wire shape of the provider's Files API: OpenAI multipart vs Anthropic multipart. */
export type FilesShape = 'openai' | 'anthropic'

/**
 * One upload per image content, for the life of the process. Keys are the
 * upload endpoint plus the bytes' SHA-256, so a screenshot that comes back in
 * a later request — or a second agent on the same route — reuses its file id
 * instead of uploading again. The ids stay stable across turns, which is what
 * keeps the prompt prefix stable too.
 */
const uploaded = new Map<string, string>()
/** Endpoints that answered "no Files API"; they keep images inline without a retry each turn. */
const unsupported = new Set<string>()
/** The multipart purpose each endpoint accepted (OpenAI takes `vision`, DeepSeek only `user_data`). */
const acceptedPurpose = new Map<string, string>()
/** Uploads in flight, so concurrent requests do not send the same image twice. */
const pending = new Map<string, Promise<string>>()

export function resetImageFiles(): void {
  uploaded.clear()
  acceptedPurpose.clear()
  pending.clear()
  unsupported.clear()
}

/** Content identity of an attachment; base64 is canonical for the same bytes. */
export function imageKey(attachment: ModelAttachment): string {
  return createHash('sha256').update(attachment.data).digest('hex')
}

/**
 * Which Files API the route speaks, or `undefined` to keep images inline.
 * `auto` follows the wire protocol; `openai` / `anthropic` force a shape;
 * `off` disables uploads; `required` makes a failed upload an error instead
 * of silently falling back to an inline image.
 */
export function filesShape(config: LlmConfig): FilesShape | undefined {
  const mode = config.filesApi ?? 'auto'
  if (mode === 'off') return undefined
  if (mode === 'openai' || mode === 'anthropic') return mode
  return config.protocol === 'anthropic' ? 'anthropic' : 'openai'
}

interface UploadTarget {
  url: string
  shape: FilesShape
  purpose: string
}

function targetOf(config: LlmConfig, shape: FilesShape): UploadTarget {
  const base = normalizeBaseUrl(config.baseUrl)
  const purpose = config.filesPurpose ?? (shape === 'anthropic' ? 'user_data' : 'vision')
  return {
    url: config.filesUrl ?? (shape === 'anthropic' ? `${base}/v1/files` : `${base}/files`),
    shape,
    purpose,
  }
}

function headersFor(config: LlmConfig, target: UploadTarget): Record<string, string> {
  if (target.shape === 'anthropic') {
    return {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
      ...(config.apiKey ? { [config.apiKeyHeader ?? 'x-api-key']: config.apiKey } : {}),
    }
  }
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
}

async function send(config: LlmConfig, target: UploadTarget, purpose: string, attachment: ModelAttachment): Promise<string> {
  const extension = attachment.mediaType.split('/')[1] ?? 'png'
  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', new Blob([Buffer.from(attachment.data, 'base64')], { type: attachment.mediaType }), attachment.name ?? `image.${extension}`)
  const response = await (config.fetch ?? fetch)(target.url, { method: 'POST', headers: headersFor(config, target), body: form })
  await assertOk(response, config.apiKey)
  const payload = await response.json() as { id?: unknown }
  if (typeof payload.id !== 'string' || !payload.id) {
    throw new OpenAICompatibleError(response.status, 'Files API response did not contain a file id')
  }
  return payload.id
}

/**
 * Upload one image and return its file id. The accepted purpose is remembered
 * per endpoint: OpenAI wants `vision`, DeepSeek rejects everything but
 * `user_data`, so the first 400 that names the purpose teaches us the rest.
 */
async function uploadOnce(config: LlmConfig, target: UploadTarget, attachment: ModelAttachment): Promise<string> {
  const known = acceptedPurpose.get(target.url)
  const purposes = known ? [known] : target.shape === 'anthropic' ? [target.purpose] : [target.purpose, 'user_data']
  let lastError: unknown
  for (const purpose of purposes) {
    try {
      const id = await send(config, target, purpose, attachment)
      acceptedPurpose.set(target.url, purpose)
      return id
    } catch (error) {
      lastError = error
      const retryablePurpose = error instanceof OpenAICompatibleError && error.status === 400 && /purpose/iu.test(`${error.message} ${error.detail ?? ''}`)
      if (!retryablePurpose) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new OpenAICompatibleError(0, 'Files API upload failed')
}

function uploadCached(config: LlmConfig, target: UploadTarget, attachment: ModelAttachment): Promise<string> {
  const key = `${target.url}|${imageKey(attachment)}`
  const done = uploaded.get(key)
  if (done) return Promise.resolve(done)
  const running = pending.get(key)
  if (running) return running
  const started = uploadOnce(config, target, attachment)
    .then(id => {
      uploaded.set(key, id)
      return id
    })
    .finally(() => pending.delete(key))
  pending.set(key, started)
  return started
}

export interface WireImages {
  /** The conversation after the image window and the text-only substitution. */
  messages: ModelMessage[]
  /** File id for an attachment, when it was uploaded; `undefined` keeps it inline. */
  fileId(attachment: ModelAttachment): string | undefined
  /** Attachments that travel as file references. */
  referenced: number
  /** Attachments that stay inline (files off, or an upload failed). */
  inline: number
}

function countAttachments(messages: readonly ModelMessage[]): number {
  let total = 0
  for (const message of messages) total += message.attachments?.length ?? 0
  return total
}

/**
 * Decide how this request's images travel. With the Files API available each
 * unique image is uploaded once and referenced by id, so the request body
 * carries no base64 — and the ids do not change between turns. A failed
 * upload keeps that one image inline unless `filesApi` is `required`.
 */
export async function prepareWireImages(
  messages: readonly ModelMessage[],
  config: LlmConfig,
): Promise<WireImages> {
  const windowed = prepareImages(messages, config)
  const shape = filesShape(config)
  if (!shape) {
    return { messages: windowed, fileId: () => undefined, referenced: 0, inline: countAttachments(windowed) }
  }
  const target = targetOf(config, shape)
  if (unsupported.has(target.url)) {
    return { messages: windowed, fileId: () => undefined, referenced: 0, inline: countAttachments(windowed) }
  }
  const ids = new Map<string, string>()
  let referenced = 0
  let inline = 0
  for (const message of windowed) {
    for (const attachment of message.attachments ?? []) {
      const key = imageKey(attachment)
      let id = ids.get(key)
      if (!id) {
        if (unsupported.has(target.url)) {
          inline += 1
          continue
        }
        try {
          id = await uploadCached(config, target, attachment)
          ids.set(key, id)
        } catch (error) {
          if (config.filesApi === 'required') throw error
          if (error instanceof OpenAICompatibleError && (error.status === 404 || error.status === 405 || error.status === 501)) {
            unsupported.add(target.url)
          }
          inline += 1
          continue
        }
      }
      referenced += 1
    }
  }
  return {
    messages: windowed,
    fileId: attachment => ids.get(imageKey(attachment)),
    referenced,
    inline,
  }
}

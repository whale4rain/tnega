import type { ModelAttachment, ModelMessage } from '@tnega/session'
import { OpenAICompatibleError } from './errors.js'
import { supportsVision } from './models.js'

export const DEFAULT_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const DEFAULT_LLM_TIMEOUT_MS = 120_000
export const DEFAULT_LLM_MAX_RETRIES = 2
export const DEFAULT_LLM_RETRY_DELAY_MS = 500

export function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

/**
 * Fold a caller's per-request overrides into the adapter's configured defaults.
 * The output cap and skipping reasoning are legitimately per call — a structured
 * side request may need a budget unrelated to the conversation's — while the
 * rest of the route (base URL, credentials, retries) stays owned by the
 * adapter's configuration.
 */
export function withCallOverrides<T extends { maxTokens?: number; reasoning?: 'off' }>(
  config: T,
  options: { maxTokens?: number; reasoning?: 'off' },
): T {
  if (options.maxTokens === undefined && options.reasoning === undefined) return config
  return {
    ...config,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
  }
}

/** DeepSeek's own API, which documents `thinking: { type: 'disabled' }`. */
export function isDeepSeekApi(baseUrl: string | undefined): boolean {
  try {
    const host = new URL(baseUrl ?? '').hostname
    return host === 'deepseek.com' || host.endsWith('.deepseek.com')
  } catch { return false }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export function isExternalAbort(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return Boolean(signal?.aborted && isAbortLike(error))
}

export function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_OPENCODE_GO_BASE_URL).replace(/\/+$/, '')
}

export function stringifyArguments(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{}'
  }
}

export function parseArguments(raw: string): unknown {
  const text = raw.trim()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return raw
  }
}

export async function assertOk(
  response: Response,
  redact?: string,
): Promise<void> {
  if (response.ok) return
  let detail: string | undefined
  try {
    const text = await response.text()
    if (text.trim()) {
      const preview = text.slice(0, 2000)
      detail = redact && preview.includes(redact)
        ? preview.replaceAll(redact, '[redacted]')
        : preview
    }
  } catch {
    detail = undefined
  }
  throw new OpenAICompatibleError(
    response.status,
    `LLM request failed with status ${response.status}`,
    detail,
  )
}

export async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new OpenAICompatibleError(
      response.status,
      'LLM response was not valid JSON',
    )
  }
}

/** Default number of most recent images a request carries. */
export const DEFAULT_MAX_IMAGES = 8

export function imageDataUrl(attachment: ModelAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`
}

/**
 * Wire policy for images: keep the newest `maxImages` (none for a text-only
 * model) and replace the rest with a short note in the message text. This
 * shapes the request only; the Session keeps every attachment.
 */
export function prepareImages(
  messages: readonly ModelMessage[],
  config: { model?: string; vision?: boolean; maxImages?: number },
): ModelMessage[] {
  if (!messages.some(message => message.attachments?.length)) return [...messages]
  const vision = config.vision ?? supportsVision(config.model ?? '')
  let budget = vision ? Math.max(0, config.maxImages ?? DEFAULT_MAX_IMAGES) : 0
  const result = [...messages]
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index]!
    const attachments = message.attachments
    if (!attachments?.length) continue
    const kept = budget > 0 ? attachments.slice(-budget) : []
    budget -= kept.length
    const omitted = attachments.length - kept.length
    if (!omitted) continue
    const reason = vision ? 'older images are dropped to bound context' : 'this model does not accept images'
    const note = `[${omitted} image${omitted === 1 ? '' : 's'} omitted: ${reason}]`
    const next: ModelMessage = { ...message, content: message.content ? `${message.content}
${note}` : note }
    if (kept.length) next.attachments = kept
    else delete next.attachments
    result[index] = next
  }
  return result
}

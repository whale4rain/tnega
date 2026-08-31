import { OpenAICompatibleError } from './errors.js'

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

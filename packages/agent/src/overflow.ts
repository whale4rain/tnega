/**
 * Whether a model request failed because the prompt no longer fits the window.
 *
 * Providers disagree on the words but agree on the shape: an HTTP 400 with a
 * message about length. A failure of this kind is the one thing a retry cannot
 * fix by itself — the same request will fail again — so it is worth telling it
 * apart from an ordinary rejection.
 *
 * Deliberately text-based and provider-agnostic: `@tnega/agent` does not depend
 * on the LLM package, and a provider added tomorrow should not need a code
 * change here.
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /input length and .*max_tokens.* exceed/i,
  /context[ _]length[ _]exceeded/i,
  /maximum context length/i,
  /exceeds? the (?:model'?s )?context (?:window|limit)/i,
  /(?:reduced|truncated).*because.*context/i,
  /too many (?:input )?tokens/i,
]

/** Every text an error carries that could name the provider's reason. */
function errorTexts(error: unknown): string[] {
  const texts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current)
    if (typeof current === 'string') {
      texts.push(current)
      break
    }
    if (current instanceof Error) {
      texts.push(current.message)
      const detail = (current as { detail?: unknown }).detail
      if (typeof detail === 'string') texts.push(detail)
      current = current.cause
      continue
    }
    if (typeof current === 'object') {
      const record = current as { message?: unknown; detail?: unknown }
      if (typeof record.message === 'string') texts.push(record.message)
      if (typeof record.detail === 'string') texts.push(record.detail)
    }
    break
  }
  return texts
}

export function isContextOverflowError(error: unknown): boolean {
  const texts = errorTexts(error)
  if (!texts.length) return false
  return OVERFLOW_PATTERNS.some(pattern => texts.some(text => pattern.test(text)))
}

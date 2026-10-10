import type { ToolError, ToolParameterSchema } from './index.js'

const MAX_DETAIL = 600

/**
 * Turn anything a tool threw into the `{name, message}` the model reads.
 *
 * A bare `error.message` often hides the reason: Node's fetch reports
 * `fetch failed` and keeps `getaddrinfo ENOTFOUND host` in `cause`, a
 * connection refused on both address families arrives as an `AggregateError`
 * with an empty message, and a thrown plain object prints as
 * `[object Object]`. The message here follows the cause chain, keeps the
 * system error code, and never comes back empty.
 */
export function toToolError(error: unknown): ToolError {
  if (error instanceof Error) {
    const result: ToolError = {
      name: error.name || 'Error',
      message: describeError(error) || error.name || 'Error',
    }
    if (error.stack) result.stack = error.stack
    return result
  }
  return {
    name: 'ToolExecutionError',
    message: describeError(error) || 'the tool failed without a reason',
  }
}

/** One line naming what went wrong, causes included, outermost first. */
export function describeError(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current)
    const text = ownText(current)
    if (text && !parts.some(part => part.includes(text))) parts.push(text)
    current = current instanceof Error ? current.cause : undefined
  }
  return clip(parts.join(': '))
}

function ownText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value instanceof AggregateError) {
    const inner = [...new Set(value.errors.map(item => ownText(item)).filter(Boolean))]
    const head = value.message.trim()
    return [head, inner.slice(0, 3).join('; ')].filter(Boolean).join(': ')
  }
  if (value instanceof Error) {
    const message = value.message.trim()
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string' && code && !message.includes(code)) {
      return message ? `${message} (${code})` : code
    }
    return message
  }
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
    try {
      return JSON.stringify(value) ?? ''
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  return value === undefined ? '' : String(value)
}

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text
}

/**
 * The tool names closest to `name`, for a model that misspelled one or used
 * a name from another harness (`bash` for `shell`, `ReadFile` for `read_file`).
 */
export function closestToolNames(name: string, names: readonly string[], limit = 3): string[] {
  const wanted = normalize(name)
  return names
    .map(candidate => {
      const other = normalize(candidate)
      const contains = other.includes(wanted) || wanted.includes(other)
      return { candidate, score: contains ? 0 : distance(wanted, other) }
    })
    .filter(entry => entry.score <= Math.max(2, Math.floor(wanted.length / 3)))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map(entry => entry.candidate)
}

function normalize(name: string): string {
  return name.replace(/[-_\s.]/gu, '').toLowerCase()
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length]!
}

/** `read_file(path: string, offset?: integer)` — the shape a call must have. */
export function describeParameters(name: string, schema: ToolParameterSchema | undefined): string {
  const properties = Object.entries(schema?.properties ?? {})
  if (!properties.length) return `${name}({})`
  const required = new Set(schema?.required ?? [])
  const fields = properties.map(([key, raw]) => {
    const property = raw && typeof raw === 'object' ? raw as ToolParameterSchema : {}
    const type = Array.isArray(property.enum)
      ? property.enum.map(value => JSON.stringify(value)).join(' | ')
      : typeof property.type === 'string' ? property.type : 'any'
    return `${key}${required.has(key) ? '' : '?'}: ${type}`
  })
  return `${name}(${fields.join(', ')})`
}

/**
 * Why a string reached a tool that takes an object: providers hand back the
 * raw text when the model's arguments were not valid JSON.
 */
export function describeUnparsedArguments(input: string): string | undefined {
  const text = input.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    JSON.parse(text)
    return undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `the arguments were not valid JSON (${reason})`
  }
}

/**
 * Raised when a tool notices the caller's abort mid-walk, or by the registry
 * when a cancelled tool never settles on its own. The agent loop reads
 * the abort from its own signal and settles the turn as cancelled; the error
 * only has to be honest about why the result is incomplete.
 */
export class ToolAbortError extends Error {
  override name = 'AbortError'

  constructor(message = 'tool call aborted') {
    super(message)
  }
}

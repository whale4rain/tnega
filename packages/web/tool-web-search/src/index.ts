import type { Context } from '@tnega/core'
import {
  optionalNumber,
  optionalString,
  record,
  stringField,
  ToolInputError,
  type ToolDefinition,
  type ToolExecuteOptions,
} from '@tnega/tools'

/**
 * `web_search` and `web_fetch` on DeepSeek's Search & Fetch API
 * (https://api-docs.deepseek.com/guides/search/): raw JSON endpoints that use
 * the same bearer key as the chat API.
 */
export interface ToolWebSearchConfig {
  /** A DeepSeek API key; without one both tools explain how to set it. */
  apiKey?: string | undefined
  /** API origin, for tests. */
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_COUNT = 8
const MAX_COUNT = 20
/** One page's Markdown is cut here so a long page cannot flood the context. */
const MAX_PAGE_CHARS = 60_000
const MAX_QUERY_CHARS = 128

/** One search hit as the model sees it. */
export interface WebSearchResult {
  title: string
  url: string
  /** The API's longer, model-oriented text for the hit. */
  summary?: string
  site?: string
  publishedAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** What a failed call tells the model, from the documented status codes. */
function failure(tool: string, status: number, message: string | undefined): Error {
  const reason: Record<number, string> = {
    401: 'the DeepSeek API key is missing or invalid',
    402: 'the DeepSeek account balance is too low',
    403: 'the page was refused by DeepSeek\'s fetch policy',
    404: 'no usable content was found',
    429: 'the rate limit was hit; wait a moment and try again',
    504: 'the upstream site timed out; try again',
  }
  const detail = reason[status] ?? (status >= 500 ? 'DeepSeek had a server error; try again' : 'the request was rejected')
  return new Error(`${tool} failed (HTTP ${status}): ${detail}${message ? ` (${message})` : ''}`)
}

async function call(
  config: ToolWebSearchConfig,
  tool: string,
  path: string,
  body: Record<string, unknown>,
  options: ToolExecuteOptions,
): Promise<Record<string, unknown>> {
  if (!config.apiKey) throw new Error(`${tool} requires DEEPSEEK_API_KEY or a DeepSeek model credential`)
  const response = await (config.fetch ?? fetch)(`${config.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  const data = isRecord(payload) ? payload : undefined
  if (!response.ok) {
    const error = data && isRecord(data.error) ? data.error : undefined
    throw failure(tool, response.status, text(error?.message))
  }
  // A success without a JSON object is a provider fault, not "no results" or an empty page.
  if (!data) throw new Error(`${tool} failed: DeepSeek returned an invalid response body`)
  return data
}

/** Build `web_search` without registering it. */
export function createWebSearchTool(config: ToolWebSearchConfig = {}): ToolDefinition {
  return {
    schema: {
      name: 'web_search',
      description: 'Search the public web for current information. Returns { results: [{ title, url, summary, site, publishedAt }] }, best first. '
        + 'The query (at most 128 characters) supports site:, -site:, "exact phrase", -term, lang:zh,en, after:2026-01-01 and before:2026. '
        + 'Read a result in full with web_fetch.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, at most 128 characters.' },
          question: { type: 'string', description: 'Optional: the user\'s original question, to help the search understand the query.' },
          count: { type: 'number', description: `Optional: how many results, 1-${MAX_COUNT} (default ${DEFAULT_COUNT}).` },
        },
        required: ['query'],
      },
    },
    interruption: 'retry',
    isConcurrencySafe: () => true,
    async execute(input, options) {
      const args = record(input)
      const query = stringField(args.query, 'query').trim()
      if (!query) throw new ToolInputError('query is required')
      if ([...query].length > MAX_QUERY_CHARS) throw new ToolInputError(`query must be at most ${MAX_QUERY_CHARS} characters`)
      const question = optionalString(args.question, 'question')?.trim()
      const count = Math.min(MAX_COUNT, Math.max(1, Math.round(optionalNumber(args.count, 'count') ?? DEFAULT_COUNT)))
      const data = await call(config, 'web_search', '/v1/tools/search', {
        query,
        count,
        ...(question ? { ori_question: [...question].slice(0, MAX_QUERY_CHARS).join('') } : {}),
      }, options)
      const results: WebSearchResult[] = []
      const seen = new Set<string>()
      if (!Array.isArray(data.results)) throw new Error('web_search failed: DeepSeek returned no results list')
      for (const value of data.results) {
        if (!isRecord(value)) continue
        const item = value
        const url = text(item.url)
        if (!url || seen.has(url)) continue
        seen.add(url)
        const summary = text(item.summary) ?? text(item.snippet)
        const site = text(item.site_name)
        const publishedAt = text(item.date)
        results.push({
          title: text(item.title) ?? url,
          url,
          ...(summary ? { summary } : {}),
          ...(site ? { site } : {}),
          ...(publishedAt ? { publishedAt } : {}),
        })
      }
      return { results }
    },
  }
}

/** Build `web_fetch` without registering it. */
export function createWebFetchPageTool(config: ToolWebSearchConfig = {}): ToolDefinition {
  return {
    schema: {
      name: 'web_fetch',
      description: 'Read one public web page as Markdown. Returns { url, title, content, truncated }. '
        + 'Use it to read a web_search result; use http_get for APIs, raw files or headers.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http or https URL of the page.' },
        },
        required: ['url'],
      },
    },
    interruption: 'retry',
    isConcurrencySafe: () => true,
    async execute(input, options) {
      const args = record(input)
      const raw = stringField(args.url, 'url').trim()
      let url: URL
      try {
        url = new URL(raw)
      } catch {
        throw new ToolInputError(`invalid URL: ${raw}`)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolInputError(`unsupported protocol: ${url.protocol}`)
      if (url.username || url.password) throw new ToolInputError('the URL must not carry credentials')
      const data = await call(config, 'web_fetch', '/v1/tools/fetch', { url: url.href }, options)
      const content = typeof data.content === 'string' ? data.content : ''
      const truncated = content.length > MAX_PAGE_CHARS
      return {
        url: url.href,
        title: typeof data.title === 'string' ? data.title : '',
        content: truncated ? content.slice(0, MAX_PAGE_CHARS) : content,
        truncated,
      }
    },
  }
}

/**
 * The web domain's DeepSeek-backed `web_search` and `web_fetch`.
 *
 * Mount: `await ctx.plugin(toolWebSearch, { apiKey })`.
 */
export const toolWebSearch = {
  name: 'tool-web-search',
  inject: ['tools'],
  apply(ctx: Context, config: ToolWebSearchConfig = {}): void {
    ctx.tools.register(createWebSearchTool(config))
    ctx.tools.register(createWebFetchPageTool(config))
  },
}

export const name = '@tnega/tool-web-search'

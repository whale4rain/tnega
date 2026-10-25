import type { Context } from '@tnega/core'
import { localExecutionProvider, type ExecutionProvider } from '@tnega/execution'
import {
  optionalNumber,
  optionalRecord,
  record,
  stringField,
  ToolInputError,
  type ToolDefinition,
  type ToolExecuteOptions,
} from '@tnega/tools'

/** The model-visible `http_get` tool. */
export interface ToolWebFetchConfig {
  /** Let requests reach private and loopback addresses (the `bypass` permission). */
  allowPrivateNetwork?: boolean | (() => boolean | Promise<boolean>)
  /** Default byte cap for a response body. */
  maxBytes?: number
  /** The execution boundary requests go through. */
  execution?: ExecutionProvider
}

const DEFAULT_MAX_BYTES = 256 * 1024

async function enabled(value: boolean | (() => boolean | Promise<boolean>)): Promise<boolean> {
  return typeof value === 'function' ? await value() : value
}

/** Build `http_get` without registering it. */
export function createWebFetchTool(config: ToolWebFetchConfig = {}): ToolDefinition {
  const execution = config.execution ?? localExecutionProvider
  const defaultMax = config.maxBytes ?? DEFAULT_MAX_BYTES
  const allowPrivate = config.allowPrivateNetwork ?? false
  return {
    schema: {
      name: 'http_get',
      description: 'Fetch a URL over HTTP(S) and return { status, ok, headers, body, truncated }.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http or https URL' },
          headers: { type: 'object', description: 'optional request headers' },
          maxBytes: { type: 'number', description: 'optional response body byte limit' },
        },
        required: ['url'],
      },
    },
    // A GET is safe to issue again after a restart cut it off.
    interruption: 'retry',
    // A GET has no effect of its own; two of them cannot disturb each other.
    isConcurrencySafe: () => true,
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const rawUrl = stringField(args.url, 'url')
      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        throw new ToolInputError(`invalid URL: ${rawUrl}`)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ToolInputError(`unsupported protocol: ${url.protocol}`)
      }
      const headers = optionalRecord(args.headers, 'headers') ?? {}
      const maxBytes = optionalNumber(args.maxBytes, 'maxBytes') ?? defaultMax
      return await execution.fetchHttp({
        url: url.href,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(maxBytes !== DEFAULT_MAX_BYTES ? { maxBytes } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(await enabled(allowPrivate) ? { allowPrivate: true } : {}),
      })
    },
  }
}

/**
 * The web domain's `http_get`. Network access is high privilege: a composition
 * mounts it only when the network was explicitly turned on.
 *
 * Mount: `await ctx.plugin(toolWebFetch, { execution })`.
 */
export const toolWebFetch = {
  name: 'tool-web-fetch',
  inject: ['tools'],
  apply(ctx: Context, config: ToolWebFetchConfig = {}): void {
    ctx.tools.register(createWebFetchTool(config))
  },
}

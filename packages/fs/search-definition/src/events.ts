import type { Context } from '@tnega/core'
import {
  SearchError,
  type FindFilesPostEvent,
  type FindFilesPreEvent,
  type FindFilesResult,
  type FindFilesSpec,
  type SearchErrorEvent,
  type SearchMatch,
  type SearchPostEvent,
  type SearchPreEvent,
  type SearchResultEvent,
  type SearchSpecBase,
  type SearchTextPostEvent,
  type SearchTextPreEvent,
  type SearchTextResult,
  type SearchTextSpec,
} from './types.js'

/**
 * 搜索缝的事件面：派发与形状校验。事件名与负载类型由本包（Service Definition）
 * 拥有，`SearchService` 的模板方法负责派发，所以任何 Provider 都自动参与全部事件，
 * 既不需要知道事件名，也无法绕过它们。
 *
 * | 事件 | 派发方式 | 作用 |
 * |---|---|---|
 * | `search/pre-search` | `waterfallAsync` | 改写已解析的 spec（策略）；不交出合法事件即失败 |
 * | `search/post-search` | `waterfallAsync` | 改写结果（脱敏、过滤、重排） |
 * | `search/result` | `parallel` | 事后通知（审计、指标、UI），正常结束时派发 |
 * | `search/error` | `parallel` | 事后通知，基础设施失败时派发 |
 *
 * 两个改写点遵循 core 的 waterfall 约定（与 `agent/pre-step`、`tools/pre-execute`
 * 一致）：**监听器就地改写负载，然后调用无参的 `next()`**，例如
 *
 * ```ts
 * ctx.on('search/pre-search', (event, next) => {
 *   event.spec = { ...event.spec, maxResults: 10 }
 *   return next()
 * })
 * ```
 *
 * 不调用 `next()`（即返回 undefined）表示拒绝这一步：搜索以 `SearchError`
 * （`SEARCH_FAILED`）失败，和 `tools/pre-execute` 的语义相同。`waterfallAsync` 在
 * 类型上返回 `Any`，所以这里必须把形状校验回来：改写后的事件 / 结果不合法同样以
 * `SEARCH_FAILED` 拒绝，绝不把半截结果当成合法结果交给模型。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/** 完全解析后的 spec 形状：`resolve*` 的默认值必须真的落定。 */
function isSearchSpec(value: unknown): value is SearchSpecBase {
  if (!isRecord(value)) return false
  return typeof value.root === 'string'
    && typeof value.maxResults === 'number'
    && isStringArray(value.excludes)
    && typeof value.respectGitignore === 'boolean'
    && typeof value.maxOutputBytes === 'number'
    && typeof value.timeoutMs === 'number'
    && (value.signal === undefined || value.signal instanceof AbortSignal)
}

function isFindFilesSpec(value: unknown): value is FindFilesSpec {
  if (!isRecord(value)) return false
  if (typeof value.pattern !== 'string') return false
  return isSearchSpec(value)
}

function isSearchTextSpec(value: unknown): value is SearchTextSpec {
  if (!isRecord(value)) return false
  if (typeof value.pattern !== 'string') return false
  if (value.glob !== undefined && typeof value.glob !== 'string') return false
  return isSearchSpec(value)
}

function isSearchMatch(value: unknown): value is SearchMatch {
  if (!isRecord(value)) return false
  return typeof value.file === 'string'
    && typeof value.line === 'number'
    && typeof value.text === 'string'
}

/** `findFiles` 结果形状：`paths` 全是字符串，`truncated` 是布尔。 */
export function isFindFilesResult(value: unknown): value is FindFilesResult {
  if (!isRecord(value)) return false
  return isStringArray(value.paths) && typeof value.truncated === 'boolean'
}

/** `searchText` 结果形状：`matches` 每条都有 `file` / `line` / `text`。 */
export function isSearchTextResult(value: unknown): value is SearchTextResult {
  if (!isRecord(value)) return false
  return Array.isArray(value.matches)
    && value.matches.every(isSearchMatch)
    && typeof value.truncated === 'boolean'
}

function isFindFilesPreEvent(value: unknown): value is FindFilesPreEvent {
  return isRecord(value) && value.op === 'findFiles' && isFindFilesSpec(value.spec)
}

function isSearchTextPreEvent(value: unknown): value is SearchTextPreEvent {
  return isRecord(value) && value.op === 'searchText' && isSearchTextSpec(value.spec)
}

function isFindFilesPostEvent(value: unknown): value is FindFilesPostEvent {
  return isRecord(value)
    && value.op === 'findFiles'
    && isFindFilesSpec(value.spec)
    && isFindFilesResult(value.result)
}

function isSearchTextPostEvent(value: unknown): value is SearchTextPostEvent {
  return isRecord(value)
    && value.op === 'searchText'
    && isSearchTextSpec(value.spec)
    && isSearchTextResult(value.result)
}

/**
 * 派发 `search/pre-search`，返回监听器就地改写后的 spec。
 *
 * @throws SearchError `SEARCH_FAILED`：监听器没有把该操作的事件交给下一层，
 * 或改写出的 spec 形状非法。
 */
export async function preFindFiles(ctx: Context, spec: FindFilesSpec): Promise<FindFilesSpec> {
  const event = { op: 'findFiles', spec } satisfies FindFilesPreEvent
  const resolved = await ctx.waterfallAsync(
    'search/pre-search',
    event,
    async (payload: SearchPreEvent) => payload,
  )
  if (!isFindFilesPreEvent(resolved)) {
    throw new SearchError(
      'search/pre-search did not forward a valid findFiles event',
      'SEARCH_FAILED',
    )
  }
  return resolved.spec
}

/** 派发 `search/pre-search`（内容检索方向）。 */
export async function preSearchText(ctx: Context, spec: SearchTextSpec): Promise<SearchTextSpec> {
  const event = { op: 'searchText', spec } satisfies SearchTextPreEvent
  const resolved = await ctx.waterfallAsync(
    'search/pre-search',
    event,
    async (payload: SearchPreEvent) => payload,
  )
  if (!isSearchTextPreEvent(resolved)) {
    throw new SearchError(
      'search/pre-search did not forward a valid searchText event',
      'SEARCH_FAILED',
    )
  }
  return resolved.spec
}

/**
 * 派发 `search/post-search`，返回监听器就地改写后的结果。
 *
 * @throws SearchError `SEARCH_FAILED`：改写后的值不是合法的 `findFiles` 结果。
 */
export async function postFindFiles(
  ctx: Context,
  spec: FindFilesSpec,
  result: FindFilesResult,
): Promise<FindFilesResult> {
  const event = { op: 'findFiles', spec, result } satisfies FindFilesPostEvent
  const resolved = await ctx.waterfallAsync(
    'search/post-search',
    event,
    async (payload: SearchPostEvent) => payload,
  )
  if (!isFindFilesPostEvent(resolved)) {
    throw new SearchError(
      'search/post-search did not produce a valid findFiles result',
      'SEARCH_FAILED',
    )
  }
  return resolved.result
}

/** 派发 `search/post-search`（内容检索方向）。 */
export async function postSearchText(
  ctx: Context,
  spec: SearchTextSpec,
  result: SearchTextResult,
): Promise<SearchTextResult> {
  const event = { op: 'searchText', spec, result } satisfies SearchTextPostEvent
  const resolved = await ctx.waterfallAsync(
    'search/post-search',
    event,
    async (payload: SearchPostEvent) => payload,
  )
  if (!isSearchTextPostEvent(resolved)) {
    throw new SearchError(
      'search/post-search did not produce a valid searchText result',
      'SEARCH_FAILED',
    )
  }
  return resolved.result
}

/** 事后通知 `search/result`；观察者失败不影响搜索结果。 */
export async function notifyResult(ctx: Context, event: SearchResultEvent): Promise<void> {
  try {
    await ctx.parallel('search/result', event)
  } catch {
    // 只读观察：观察者失败不改写权威结论。
  }
}

/** 事后通知 `search/error`；观察者失败不取代原始失败的 `SEARCH_*` 错误码。 */
export async function notifyError(ctx: Context, event: SearchErrorEvent): Promise<void> {
  try {
    await ctx.parallel('search/error', event)
  } catch {
    // 只读观察：观察者失败不改写权威结论。
  }
}

/** 把任意抛出物归一成事件负载里的 `error` 字段。 */
export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

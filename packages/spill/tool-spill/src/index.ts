import type { Context } from '@tnega/core'
import { renderToolResult } from '@tnega/session'
import type { SpillRef, SpillStore } from '@tnega/spill'
import type { ToolStagePayload } from '@tnega/tools'

/**
 * 单个工具结果进入模型上下文的字节上限；不给就用默认值。
 *
 * 这是「模型看得见多少」的上限，不是工具产出多少的上限：超出的部分不丢，整份
 * 落在溢出存储里，模型拿到的是头尾预览加定位符。
 */
export const DEFAULT_MAX_INLINE_BYTES = 50_000
/** 预览保留的头部字节数。 */
export const DEFAULT_HEAD_BYTES = 12_000
/** 预览保留的尾部字节数——从后往前留，最近的输出通常最要紧。 */
export const DEFAULT_TAIL_BYTES = 4_000

/**
 * 默认不参与溢出的工具。
 *
 * `read_file` 排除在外：它已经是「按需读一段」的工具，把它溢出会让模型为了读回
 * 刚读的东西再去读一个文件，绕成环。
 */
export const DEFAULT_SPILL_SKIP: readonly string[] = ['read_file']

/** 预览被省略时留在头尾之间的标记。 */
const GAP = '\n…\n'

export interface ToolSpillConfig {
  /** 单个结果的模型可见上限，UTF-8 字节。 */
  maxInlineBytes?: number
  /** 预览保留的头部字节数。 */
  headBytes?: number
  /** 预览保留的尾部字节数。 */
  tailBytes?: number
  /** 不参与溢出的工具名；默认见 {@link DEFAULT_SPILL_SKIP}。 */
  skip?: readonly string[]
}

interface ResolvedConfig {
  maxInlineBytes: number
  headBytes: number
  tailBytes: number
  skip: ReadonlySet<string>
}

const decoder = new TextDecoder('utf-8')

/** 头部窗口；末尾若落在码点中间，丢掉那个不完整的字符。 */
function headText(buffer: Buffer, bytes: number): string {
  const text = decoder.decode(buffer.subarray(0, Math.min(bytes, buffer.length)))
  return text.endsWith('�') ? text.slice(0, -1) : text
}

/** 尾部窗口；开头若落在码点中间，丢掉那个不完整的字符。 */
function tailText(buffer: Buffer, bytes: number): string {
  const text = decoder.decode(buffer.subarray(Math.max(0, buffer.length - bytes)))
  return text.startsWith('�') ? text.slice(1) : text
}

/** 模型看到的省略说明。格式与 `apps/web` 的识别保持同步。 */
export function formatSpillNotice(omittedBytes: number, ref: SpillRef): string {
  return `\n\n(Omitted ${omittedBytes} bytes. Full formatted result stored at: `
    + `${ref.locator}. ${ref.retrievalHint})`
}

/**
 * 把头尾预览和省略说明拼成不超过 `maxInlineBytes` 的替换文本。
 *
 * 返回 `undefined` 表示拼不进去（上限太小、或定位符本身太长）：此时调用方保留
 * 原文，宁可在上下文里放大的，也不放一个残缺到读不懂的。
 */
export function composeSpillNotice(
  text: string,
  ref: SpillRef,
  config: { maxInlineBytes: number; headBytes: number; tailBytes: number },
): string | undefined {
  const buffer = Buffer.from(text, 'utf8')
  const total = buffer.length
  if (total <= config.maxInlineBytes) return undefined
  let omitted = total
  let preview = ''
  // 说明本身的长度取决于被省略的字节数，而被省略的字节数又取决于说明给预览留了
  // 多少位置。两者只可能在「省略数的位数」上互相影响，跑两趟就稳定了。
  for (let pass = 0; pass < 3; pass += 1) {
    const noticeBytes = Buffer.byteLength(formatSpillNotice(omitted, ref), 'utf8')
    const room = config.maxInlineBytes - noticeBytes - Buffer.byteLength(GAP, 'utf8')
    if (room < 0) return undefined
    // 头尾按配置的比例分配剩余空间。两者都按比例收缩，而不是让头部吃掉全部余量：
    // 结果的结尾通常才是模型最需要看的地方，只留头等于把它丢掉。
    const wanted = config.headBytes + config.tailBytes
    const headRoom = wanted > room
      ? Math.floor(config.headBytes * (room / wanted))
      : config.headBytes
    const tailRoom = Math.min(config.tailBytes, room - headRoom)
    preview = headText(buffer, headRoom) + GAP + tailText(buffer, tailRoom)
    const next = total - Buffer.byteLength(preview, 'utf8')
    if (next === omitted) break
    omitted = next
  }
  const replacement = preview + formatSpillNotice(omitted, ref)
  if (Buffer.byteLength(replacement, 'utf8') > config.maxInlineBytes) return undefined
  return replacement
}

function resolveConfig(config: ToolSpillConfig): ResolvedConfig {
  const maxInlineBytes = config.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  if (!Number.isFinite(maxInlineBytes) || maxInlineBytes < 0) {
    throw new TypeError('tool-spill maxInlineBytes must be a non-negative number')
  }
  return {
    maxInlineBytes,
    headBytes: config.headBytes ?? DEFAULT_HEAD_BYTES,
    tailBytes: config.tailBytes ?? DEFAULT_TAIL_BYTES,
    skip: new Set(config.skip ?? DEFAULT_SPILL_SKIP),
  }
}

/**
 * 把一个过大的工具结果换成「头尾预览 + 定位符」，整份文本落到 `ctx.spillStore`。
 *
 * 只在结果是成功结果、且同一条缝上还挂着后端时动它。**尽力而为**：落盘失败时保留
 * 原文并记一条 warning —— 溢出失败不该把一个成功的工具调用变成失败的，也不该让
 * 内容凭空消失。
 */
async function spillIfOversized(
  ctx: Context,
  store: SpillStore,
  payload: ToolStagePayload,
  config: ResolvedConfig,
): Promise<void> {
  const { request, result } = payload
  if (!result.ok) return
  if (config.skip.has(request.name)) return
  const text = renderToolResult(result)
  if (Buffer.byteLength(text, 'utf8') <= config.maxInlineBytes) return
  try {
    const ref = await store.saveText({
      source: {
        kind: 'tool',
        toolName: request.name,
        callId: request.options.callId ?? 'call',
        label: 'output',
      },
      suggestedName: `${request.name}.txt`,
      content: text,
    })
    const replacement = composeSpillNotice(text, ref, config)
    // 拼不进上限就保留原文：落盘的那份仍在，只是没能把它请出上下文。
    if (replacement !== undefined) result.output = replacement
  } catch (error) {
    ctx.logger.warn(
      `tool-spill: could not spill ${request.name} output: ${String((error as Error)?.message ?? error)}`,
    )
  }
}

export const name = 'tool-spill'

export function apply(ctx: Context, config: ToolSpillConfig = {}): void {
  const resolved = resolveConfig(config)
  const store = ctx.get('spillStore') as SpillStore
  ctx.on(
    'tools/post-execute',
    async (payload: ToolStagePayload, next: () => unknown) => {
      await spillIfOversized(ctx, store, payload, resolved)
      return next()
    },
  )
}

/**
 * 把过大的工具结果挡在模型上下文之外，完整记录留给溢出存储。
 *
 * 只 import `@tnega/spill` 的契约，不 import 任何后端；换后端只改 composition
 * 层的挂载。挂载：`await ctx.plugin(toolSpill, { maxInlineBytes })`，同时必须挂一个
 * `ctx.spillStore` 后端（例如 `@tnega/spill-local`）。
 */
export const toolSpill = {
  name,
  /** 工具管线（挂 `tools/post-execute`）与溢出存储的契约。 */
  inject: ['tools', 'spillStore'],
  apply,
}

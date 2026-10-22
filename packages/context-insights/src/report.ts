import {
  DEFAULT_CONTEXT_COMPACT_RATIO,
  DEFAULT_CONTEXT_LIMIT,
  deriveEventMessage,
  estimateMessageTokens,
  foldSessionMeta,
  type ModelMessage,
  type ModelRole,
  type SessionEvent,
} from '@tnega/session'
import { effectiveLlmConfig, type ModelPricing, type SystemConfig } from '@tnega/config'
import { eachResponse, responseCost, type CostEstimate } from '@tnega/usage'

/**
 * What a request's prompt is made of. System prompt and tool schemas come
 * from the request header; the rest from the folded model surface. Injected
 * context is every system message after the first, user messages the harness
 * or a plugin wrote (they carry a name), and compaction summaries.
 */
export const CONTEXT_CATEGORIES = ['system', 'tools', 'user', 'injected', 'assistant', 'results'] as const
export type ContextCategory = typeof CONTEXT_CATEGORIES[number]
export type Composition = Record<ContextCategory, number>

/** Where a session's active time went. Model time is split by what the stream was doing. */
export interface ContextTiming {
  /** Turn spans added up: from a turn's start to its end. */
  activeMs: number
  /** Request start to the first streamed token. */
  waitingMs: number
  /** Streaming reasoning. */
  thinkingMs: number
  /** Streaming the answer and tool arguments. */
  respondingMs: number
  /** Tools running. */
  toolMs: number
  /** Active time no model call or tool accounts for: approvals, harness work, queues. */
  otherMs: number
  modelCalls: number
  toolRuns: number
}

/** One model request: what its prompt was estimated to hold, and what the provider reported. */
export interface ContextStep {
  turn: number
  /** Index of this request within its turn, from 1. */
  step: number
  ts: number
  modelId: string
  estimate: Composition
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  cost?: CostEstimate
  /** A compaction (or request rewrite) changed the surface since the previous step. */
  compacted?: boolean
  toolCalls: number
  timing: Omit<ContextTiming, 'activeMs' | 'otherMs' | 'modelCalls'>
}

export interface ContextTurn {
  turn: number
  start: number
  end: number
}

export interface SessionContextReport {
  title: string
  model?: string
  /** The model's context window, in tokens. */
  window: number
  /** Auto-compaction starts at this share of the window. */
  compactAt: number
  current: {
    estimate: Composition
    /** Same figure the composer's context ring shows: the provider's last prompt size, or the estimate. */
    tokens: number
    source: 'provider' | 'estimate'
  }
  stats: {
    turns: number
    steps: number
    userInputs: number
    toolCalls: number
    toolErrors: number
    compactions: number
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    reasoningTokens: number
    cacheHitRate?: number
    cost?: CostEstimate[]
    /** Steps whose model has a price; the rest add no cost. */
    pricedSteps: number
  }
  /** Billed prompt tokens split by composition, plus output. */
  billed: { composition: Composition; output: number }
  timing: ContextTiming
  steps: ContextStep[]
  turns: ContextTurn[]
  /** The last thing the user said, shortened. */
  lastMessage?: string
  updatedAt: number
}

export function emptyComposition(): Composition {
  return { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, results: 0 }
}

export function compositionTotal(value: Composition): number {
  let sum = 0
  for (const category of CONTEXT_CATEGORIES) sum += value[category]
  return sum
}

export function addComposition(into: Composition, value: Composition, factor = 1): void {
  for (const category of CONTEXT_CATEGORIES) into[category] += value[category] * factor
}

interface Part { role: ModelRole; tokens: number; injected: boolean }
interface SurfaceNode { seq: number; reset: boolean; parts: Part[] }

/**
 * A named user message was written by the harness or a plugin on the user's
 * behalf (a nudge to continue, an inbox note), so it counts as injected.
 */
function injectedUser(message: ModelMessage): boolean {
  return message.role === 'user' && Boolean(message.name)
}

function messageParts(messages: readonly ModelMessage[], summary?: string): Part[] {
  return messages.map(message => ({
    role: message.role,
    tokens: estimateMessageTokens([message]),
    injected: injectedUser(message) || (summary !== undefined && summary.length > 0 && message.content.includes(summary)),
  }))
}

/** Same rule as the model surface fold: a checkpoint node replaces everything before it. */
function surfaceComposition(nodes: readonly SurfaceNode[], header: { system: number; tools: number }): Composition {
  let start = 0
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index]!.reset) { start = index; break }
  }
  const result = emptyComposition()
  let sawSystem = false
  for (const node of nodes.slice(start)) {
    for (const part of node.parts) {
      if (part.injected) result.injected += part.tokens
      else if (part.role === 'system') {
        if (sawSystem) result.injected += part.tokens
        else result.system += part.tokens
        sawSystem = true
      } else if (part.role === 'user') result.user += part.tokens
      else if (part.role === 'assistant') result.assistant += part.tokens
      else result.results += part.tokens
    }
  }
  // A run-scoped system prompt lives only in the request header.
  if (!sawSystem) result.system += header.system
  result.tools += header.tools
  return result
}

function estimateText(text: string | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/** Request start, first token, reasoning span and end, read off the committed stream. */
function streamTiming(event: Extract<SessionEvent, { type: 'assistant/message' }>): { waitingMs: number; thinkingMs: number; respondingMs: number } {
  const records = event.payload.stream ?? []
  const duration = event.payload.durationMs
  const end = duration !== undefined ? event.ts : records.at(-1)?.time ?? event.ts
  const start = duration !== undefined ? event.ts - duration : records[0]?.time ?? event.ts
  const total = Math.max(0, end - start)
  let first: number | undefined
  let reasoningStart: number | undefined
  let reasoningEnd: number | undefined
  for (const record of records) {
    const type = record.chunk.type
    if (type === 'message_delta' || type === 'reasoning_delta' || type === 'toolcall_start') first ??= record.time
    if (type === 'reasoning_delta') {
      reasoningStart ??= record.time
      reasoningEnd = record.time
    } else if (reasoningStart !== undefined && reasoningEnd !== undefined && (type === 'message_delta' || type === 'toolcall_start')) {
      // Reasoning ends where the answer begins.
      reasoningEnd = Math.max(reasoningEnd, record.time)
      break
    }
  }
  if (first === undefined) return { waitingMs: 0, thinkingMs: 0, respondingMs: total }
  const waitingMs = Math.min(total, Math.max(0, first - start))
  const thinkingMs = reasoningStart !== undefined && reasoningEnd !== undefined
    ? Math.min(total - waitingMs, Math.max(0, reasoningEnd - reasoningStart))
    : 0
  return { waitingMs, thinkingMs, respondingMs: Math.max(0, total - waitingMs - thinkingMs) }
}

function shorten(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function addCost(into: Map<string, number>, cost: CostEstimate | undefined): void {
  if (cost) into.set(cost.currency, (into.get(cost.currency) ?? 0) + cost.amount)
}

export function costList(costs: Map<string, number>): CostEstimate[] | undefined {
  return costs.size ? [...costs].map(([currency, amount]) => ({ currency, amount })) : undefined
}

export interface ReportOptions {
  /** Prices and windows by model route; defaults to the process environment's view of `config`. */
  pricing?: (modelId: string) => ModelPricing | undefined
  window?: (modelId: string | undefined) => number | undefined
  updatedAt?: number
}

/**
 * Fold one session's durable events into its context report. Everything is
 * derived from the log, so a replayed session reports what the live one did.
 * Prompt makeup is estimated with the session's own token rule
 * (`estimateMessageTokens`); provider figures are reported beside it.
 */
export function sessionContextReport(events: readonly SessionEvent[], config: SystemConfig, options: ReportOptions = {}): SessionContextReport {
  const defaultModel = effectiveLlmConfig(config).modelId
  const priceCache = new Map<string, ModelPricing | undefined>()
  const pricing = options.pricing ?? ((modelId: string) => {
    if (!priceCache.has(modelId)) priceCache.set(modelId, effectiveLlmConfig(config, process.env, modelId).pricing)
    return priceCache.get(modelId)
  })
  const models: string[] = []
  eachResponse(events, '', (_usage, modelId) => models.push(modelId || defaultModel))

  const nodes: SurfaceNode[] = []
  const header = { system: 0, tools: 0 }
  let requestWindow: number | undefined
  const steps: ContextStep[] = []
  const turns: ContextTurn[] = []
  let turn = 0
  let stepInTurn = 0
  let sawTurnEvents = false
  let openTurn: ContextTurn | undefined
  let compactedSinceStep = false
  let userInputs = 0
  let toolCalls = 0
  let toolErrors = 0
  let compactions = 0
  let lastMessage: string | undefined
  let latestSurface: SessionEvent | undefined
  let lastTs = 0

  const replace = (start: number, end: number, node: SurfaceNode): void => {
    const startIndex = nodes.findIndex(item => item.seq === start)
    const endIndex = startIndex < 0 ? -1 : nodes.findIndex((item, index) => index >= startIndex && item.seq === end)
    if (startIndex < 0 || endIndex < 0) { nodes.push(node); return }
    nodes.splice(startIndex, endIndex - startIndex + 1, node)
  }

  for (const event of events) {
    lastTs = Math.max(lastTs, event.ts)
    switch (event.type) {
      case 'request/header':
        header.system = estimateText(event.payload.system)
        header.tools = event.payload.tools?.length ? Math.ceil((JSON.stringify(event.payload.tools)?.length ?? 0) / 4) : 0
        break
      case 'request/context':
        if (event.payload.contextWindow !== undefined) requestWindow = event.payload.contextWindow
        break
      case 'turn/start':
        if (!sawTurnEvents) { sawTurnEvents = true; turn = 0 }
        turn = typeof event.payload.turn === 'number' && event.payload.turn > turn ? event.payload.turn : turn + 1
        stepInTurn = 0
        openTurn = { turn, start: event.ts, end: event.ts }
        turns.push(openTurn)
        break
      case 'turn/end':
        if (openTurn) { openTurn.end = event.ts; openTurn = undefined }
        break
      case 'checkpoint': {
        const range = event.payload.surfaceOp
        const node: SurfaceNode = { seq: event.seq, reset: true, parts: messageParts(event.payload.messages, event.payload.summary) }
        if (typeof range === 'object' && range !== null && range.op === 'replace') replace(range.start, range.end, node)
        else nodes.push(node)
        if (event.payload.summary !== undefined || event.payload.tokensBefore !== undefined) compactions += 1
        compactedSinceStep = true
        break
      }
      default:
        break
    }
    if (event.type === 'user/message' || event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      if (event.type === 'user/message' && !event.payload.name) {
        userInputs += 1
        if (event.payload.content.trim()) lastMessage = shorten(event.payload.content)
        if (!sawTurnEvents) { turn += 1; stepInTurn = 0 }
      }
      if (event.type === 'tool/result') {
        toolCalls += 1
        if (!event.payload.ok) toolErrors += 1
        const current = steps.at(-1)
        if (current) {
          current.toolCalls += 1
          current.timing.toolMs += event.payload.durationMs ?? 0
          current.timing.toolRuns += 1
        }
      }
      if (event.type === 'assistant/message' && event.payload.usage) {
        const usage = event.payload.usage
        const modelId = models[steps.length] ?? defaultModel
        const price = pricing(modelId)
        stepInTurn += 1
        const step: ContextStep = {
          turn: Math.max(turn, 1),
          step: stepInTurn,
          ts: event.ts,
          modelId,
          estimate: surfaceComposition(nodes, header),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          toolCalls: 0,
          timing: { ...streamTiming(event), toolMs: 0, toolRuns: 0 },
        }
        if (usage.cachedTokens !== undefined) step.cachedTokens = usage.cachedTokens
        if (usage.reasoningTokens !== undefined) step.reasoningTokens = usage.reasoningTokens
        if (price) step.cost = { currency: price.currency ?? 'USD', amount: responseCost(usage, price) }
        if (compactedSinceStep && steps.length > 0) step.compacted = true
        compactedSinceStep = false
        steps.push(step)
      }
      const message = deriveEventMessage(event)
      const node: SurfaceNode = { seq: event.seq, reset: false, parts: message ? messageParts([message]) : [] }
      const op = event.surfaceOp ?? 'append'
      if (op === 'append') nodes.push(node)
      else replace(op.start, op.end, node)
      latestSurface = event
    }
  }
  if (openTurn) openTurn.end = Math.max(openTurn.end, lastTs)

  const meta = foldSessionMeta(events)
  const window = options.window?.(meta.model) ?? requestWindow ?? DEFAULT_CONTEXT_LIMIT
  const estimate = surfaceComposition(nodes, header)
  const provider = latestSurface?.type === 'assistant/message' ? latestSurface.payload.usage : undefined

  const billed = emptyComposition()
  const costs = new Map<string, number>()
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let cacheBase = 0
  let reasoningTokens = 0
  let pricedSteps = 0
  const timing: ContextTiming = { activeMs: 0, waitingMs: 0, thinkingMs: 0, respondingMs: 0, toolMs: 0, otherMs: 0, modelCalls: steps.length, toolRuns: 0 }
  for (const step of steps) {
    scaleInto(billed, step.estimate, step.promptTokens)
    promptTokens += step.promptTokens
    completionTokens += step.completionTokens
    reasoningTokens += step.reasoningTokens ?? 0
    if (step.cachedTokens !== undefined) { cachedTokens += step.cachedTokens; cacheBase += step.promptTokens }
    if (step.cost) { pricedSteps += 1; addCost(costs, step.cost) }
    timing.waitingMs += step.timing.waitingMs
    timing.thinkingMs += step.timing.thinkingMs
    timing.respondingMs += step.timing.respondingMs
    timing.toolMs += step.timing.toolMs
    timing.toolRuns += step.timing.toolRuns
  }
  const busy = timing.waitingMs + timing.thinkingMs + timing.respondingMs + timing.toolMs
  timing.activeMs = turns.length ? turns.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0) : busy
  timing.activeMs = Math.max(timing.activeMs, busy)
  timing.otherMs = timing.activeMs - busy

  const stats: SessionContextReport['stats'] = {
    turns: sawTurnEvents ? turns.length : turn,
    steps: steps.length,
    userInputs,
    toolCalls,
    toolErrors,
    compactions,
    promptTokens,
    completionTokens,
    cachedTokens,
    reasoningTokens,
    pricedSteps,
  }
  if (cacheBase > 0) stats.cacheHitRate = cachedTokens / cacheBase
  const cost = costList(costs)
  if (cost) stats.cost = cost

  const report: SessionContextReport = {
    title: meta.title ?? 'New session',
    window,
    compactAt: DEFAULT_CONTEXT_COMPACT_RATIO,
    current: provider
      ? { estimate, tokens: provider.promptTokens, source: 'provider' }
      : { estimate, tokens: Math.round(compositionTotal(estimate)), source: 'estimate' },
    stats,
    billed: { composition: roundComposition(billed), output: completionTokens },
    timing,
    steps,
    turns,
    updatedAt: options.updatedAt ?? lastTs,
  }
  if (meta.model) report.model = meta.model
  if (lastMessage) report.lastMessage = lastMessage
  return report
}

/**
 * Spread a provider's prompt count over the estimated makeup, so the billed
 * split adds up to what was billed. An empty estimate counts as user input.
 */
export function scaleInto(into: Composition, estimate: Composition, promptTokens: number): void {
  const total = compositionTotal(estimate)
  if (total <= 0) { into.user += promptTokens; return }
  addComposition(into, estimate, promptTokens / total)
}

export function roundComposition(value: Composition): Composition {
  const result = emptyComposition()
  for (const category of CONTEXT_CATEGORIES) result[category] = Math.round(value[category])
  return result
}

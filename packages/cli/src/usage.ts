import { foldSessionMeta, type ModelUsage, type SessionEvent } from '@tnega/session'
import { effectiveLlmConfig, type ModelPricing, type SystemConfig } from './config.js'

/** Token use over some span, as providers reported it. */
export interface UsageTotals {
  responses: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  reasoningTokens: number
  /** `cachedTokens / promptTokens` over responses that reported cache accounting. */
  cacheHitRate?: number
  /** Estimated spend, one entry per currency; absent when no price is set. */
  cost?: CostEstimate[]
}

export interface CostEstimate {
  amount: number
  currency: string
}

export interface ModelUsageTotals extends UsageTotals {
  modelId: string
  name: string
  /** False when no price is configured for the route, so its cost is unknown. */
  priced: boolean
}

export interface WorkspaceUsage {
  today: UsageTotals
  week: UsageTotals
  total: UsageTotals
  byModel: ModelUsageTotals[]
  sessions: number
  responses: UsageResponse[]
}

export interface UsageResponse extends UsageTotals {
  sessionId: string
  sessionTitle: string
  timestamp: number
  modelId: string
  projectId?: string
  threadId?: string
}

interface Accumulator {
  responses: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  reasoningTokens: number
  /** Prompt tokens of the responses that reported a cache count. */
  cacheBase: number
  cost: Map<string, number>
}

function accumulator(): Accumulator {
  return { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cacheBase: 0, cost: new Map() }
}

/** Cost of one response: uncached prompt, cached prompt and output at their prices. */
export function responseCost(usage: ModelUsage, pricing: ModelPricing): number {
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens)
  const fresh = usage.promptTokens - cached
  return (fresh * pricing.input + cached * (pricing.cachedInput ?? pricing.input) + usage.completionTokens * pricing.output) / 1_000_000
}

function add(into: Accumulator, usage: ModelUsage, pricing: ModelPricing | undefined): void {
  into.responses += 1
  into.promptTokens += usage.promptTokens
  into.completionTokens += usage.completionTokens
  into.reasoningTokens += usage.reasoningTokens ?? 0
  if (usage.cachedTokens !== undefined) {
    into.cachedTokens += usage.cachedTokens
    into.cacheBase += usage.promptTokens
  }
  if (pricing) {
    const currency = pricing.currency ?? 'USD'
    into.cost.set(currency, (into.cost.get(currency) ?? 0) + responseCost(usage, pricing))
  }
}

function totals(from: Accumulator): UsageTotals {
  const result: UsageTotals = {
    responses: from.responses,
    promptTokens: from.promptTokens,
    completionTokens: from.completionTokens,
    cachedTokens: from.cachedTokens,
    reasoningTokens: from.reasoningTokens,
  }
  if (from.cacheBase > 0) result.cacheHitRate = from.cachedTokens / from.cacheBase
  if (from.cost.size) result.cost = [...from.cost].map(([currency, amount]) => ({ currency, amount }))
  return result
}

/**
 * Walk one session's responses with the model route each ran on. A session
 * starts on its creation route (or the default) and follows later model
 * switches recorded in its metadata.
 */
export function eachResponse(
  events: readonly SessionEvent[],
  defaultModel: string,
  visit: (usage: ModelUsage, modelId: string, ts: number) => void,
): void {
  let model = defaultModel
  for (const event of events) {
    if (event.type === 'meta') {
      const payload = event.payload as Record<string, unknown>
      if (typeof payload.kind === 'string' && payload.kind.startsWith('approval/')) continue
      if (typeof payload.model === 'string' && payload.model) model = payload.model
    } else if (event.type === 'meta/patch' && event.payload.fields.includes('model')) {
      model = event.payload.model || defaultModel
    } else if (event.type === 'assistant/message' && event.payload.usage) {
      visit(event.payload.usage, model, event.ts)
    }
  }
}

/** One session's totals, priced by the routes it ran on. */
export function sessionUsage(events: readonly SessionEvent[], config: SystemConfig): UsageTotals {
  const defaultModel = effectiveLlmConfig(config).modelId
  const sum = accumulator()
  const prices = pricesFor(config)
  eachResponse(events, defaultModel, (usage, modelId) => add(sum, usage, prices(modelId)))
  return totals(sum)
}

/** Today, the last seven days and all time across a workspace's sessions, plus a split by model. */
export function workspaceUsage(sessions: ReadonlyArray<readonly SessionEvent[]>, config: SystemConfig, now = Date.now(), sessionIds: readonly string[] = []): WorkspaceUsage {
  const defaultModel = effectiveLlmConfig(config).modelId
  const prices = pricesFor(config)
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const dayStart = startOfDay.getTime()
  const weekStart = dayStart - 6 * 24 * 60 * 60 * 1000
  const today = accumulator()
  const week = accumulator()
  const total = accumulator()
  const byModel = new Map<string, Accumulator>()
  const responses: UsageResponse[] = []
  for (const [index, events] of sessions.entries()) {
    const meta = foldSessionMeta(events)
    eachResponse(events, defaultModel, (usage, modelId, ts) => {
      const pricing = prices(modelId)
      const response = accumulator()
      add(response, usage, pricing)
      responses.push({ ...totals(response), sessionId: sessionIds[index] ?? String(index), sessionTitle: meta.title ?? 'Session', timestamp: ts, modelId })
      add(total, usage, pricing)
      if (ts >= weekStart) add(week, usage, pricing)
      if (ts >= dayStart) add(today, usage, pricing)
      let model = byModel.get(modelId)
      if (!model) byModel.set(modelId, model = accumulator())
      add(model, usage, pricing)
    })
  }
  return {
    today: totals(today),
    week: totals(week),
    total: totals(total),
    byModel: [...byModel].map(([modelId, sum]) => ({
      modelId,
      name: config.models?.find(route => route.id === modelId)?.name ?? modelId,
      priced: prices(modelId) !== undefined,
      ...totals(sum),
    })).sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens)),
    sessions: sessions.length,
    responses: responses.sort((a, b) => b.timestamp - a.timestamp),
  }
}

function pricesFor(config: SystemConfig): (modelId: string) => ModelPricing | undefined {
  const cache = new Map<string, ModelPricing | undefined>()
  return modelId => {
    if (!cache.has(modelId)) cache.set(modelId, effectiveLlmConfig(config, process.env, modelId).pricing)
    return cache.get(modelId)
  }
}

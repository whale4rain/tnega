import { describe, expect, it } from 'vitest'
import type { ModelUsage, SessionEvent } from '@tnega/session'
import { parseModelRouteInput, ModelRouteError, type SystemConfig } from '../src/config.js'
import { responseCost, sessionUsage, workspaceUsage } from '../src/usage.js'

let seq = 0
const reply = (usage: ModelUsage, ts: number): SessionEvent => ({ id: `a${++seq}`, seq, ts, type: 'assistant/message', payload: { content: 'ok', usage } } as SessionEvent)
const switchTo = (model: string, ts: number): SessionEvent => ({ id: `m${++seq}`, seq, ts, type: 'meta', payload: { model } } as SessionEvent)

const config: SystemConfig = {
  model: 'flash',
  models: [
    { id: 'flash', model: 'deepseek-chat', name: 'DeepSeek Flash', pricing: { input: 2, cachedInput: 0.5, output: 8, currency: 'CNY' } },
    { id: 'pro', model: 'pro-model', name: 'Pro' },
  ],
}

describe('usage', () => {
  it('retains timestamp, session and model details for the calendar', () => {
    const at = new Date(2026, 9, 6, 12).getTime()
    const summary = workspaceUsage([[switchTo('pro', at - 1), reply({ promptTokens: 10, completionTokens: 3, cachedTokens: 4 }, at)]], config, at, ['session-one'])
    expect(summary.responses).toEqual([expect.objectContaining({
      sessionId: 'session-one', timestamp: at, modelId: 'pro', promptTokens: 10, completionTokens: 3, cachedTokens: 4,
    })])
  })
  it('prices cached prompt tokens at the cache price', () => {
    expect(responseCost({ promptTokens: 1_000_000, cachedTokens: 600_000, completionTokens: 100_000 }, { input: 2, cachedInput: 0.5, output: 8 }))
      .toBeCloseTo(0.8 + 0.3 + 0.8)
    expect(responseCost({ promptTokens: 1_000_000, completionTokens: 0 }, { input: 1, output: 4 })).toBe(1)
  })

  it('totals a session with its cache hit rate and cost, following model switches', () => {
    const usage = sessionUsage([
      reply({ promptTokens: 1000, cachedTokens: 800, completionTokens: 100, reasoningTokens: 30 }, 1),
      switchTo('pro', 2),
      reply({ promptTokens: 3000, completionTokens: 50 }, 3),
    ], config)
    expect(usage).toMatchObject({ responses: 2, promptTokens: 4000, completionTokens: 150, cachedTokens: 800, reasoningTokens: 30 })
    // Only the response that reported cache accounting counts toward the rate.
    expect(usage.cacheHitRate).toBeCloseTo(0.8)
    // The unpriced route adds nothing rather than a made-up price.
    expect(usage.cost).toEqual([{ currency: 'CNY', amount: expect.closeTo((200 * 2 + 800 * 0.5 + 100 * 8) / 1e6, 10) }])
  })

  it('splits a workspace into today, the last week and all time, and by model', () => {
    const now = new Date(2026, 9, 5, 15).getTime()
    const day = 24 * 60 * 60 * 1000
    const summary = workspaceUsage([
      [reply({ promptTokens: 100, completionTokens: 10 }, now - 30 * day)],
      [reply({ promptTokens: 200, completionTokens: 20 }, now - 3 * day), switchTo('pro', now - day), reply({ promptTokens: 400, completionTokens: 40 }, now - 60_000)],
    ], config, now)
    expect(summary.sessions).toBe(2)
    expect(summary.today.promptTokens).toBe(400)
    expect(summary.week.promptTokens).toBe(600)
    expect(summary.total.promptTokens).toBe(700)
    expect(summary.byModel.map(model => [model.name, model.promptTokens, model.priced])).toEqual([['Pro', 400, false], ['DeepSeek Flash', 300, true]])
    expect(summary.today.cost).toBeUndefined()
  })

  it('accepts route prices and rejects partial ones', () => {
    expect(parseModelRouteInput({ model: 'm', pricing: { input: 1, output: 2, currency: 'usd' } }).pricing).toEqual({ input: 1, output: 2, currency: 'USD' })
    expect(parseModelRouteInput({ model: 'm', pricing: null }).pricing).toBeNull()
    expect(() => parseModelRouteInput({ model: 'm', pricing: { input: 1 } })).toThrow(ModelRouteError)
    expect(() => parseModelRouteInput({ model: 'm', pricing: { input: -1, output: 2 } })).toThrow(ModelRouteError)
  })
})

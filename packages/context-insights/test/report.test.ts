import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@tnega/session'
import type { SystemConfig } from '@tnega/config'
import { compositionTotal, contextInsights, sessionContextReport, type InsightsSource } from '../src/index.js'

const config: SystemConfig = {
  model: 'flash',
  models: [
    { id: 'flash', model: 'deepseek-chat', name: 'Flash', contextWindow: 10_000, pricing: { input: 2, cachedInput: 0.5, output: 8, currency: 'CNY' } },
    { id: 'pro', model: 'pro-model', name: 'Pro' },
  ],
}

function builder(start = 1_000) {
  let seq = 0
  let ts = start
  const events: SessionEvent[] = []
  const push = (type: string, payload: unknown, extra: Record<string, unknown> = {}, at?: number): SessionEvent => {
    seq += 1
    ts = at ?? ts + 100
    const event = { id: `e${seq}`, seq, ts, type, payload, ...extra } as SessionEvent
    events.push(event)
    return event
  }
  return { events, push, now: () => ts }
}

const text = (tokens: number) => 'x'.repeat(tokens * 4)

function session(start = 1_000) {
  const b = builder(start)
  b.push('meta', { title: 'Fix the parser', model: 'flash', createdAt: start })
  b.push('request/header', { reason: 'initial', system: text(50), tools: [{ name: 'read', description: text(20) }] })
  b.push('request/context', { model: 'deepseek-chat', contextWindow: 10_000 })
  b.push('system/message', { content: text(50) }, { surfaceOp: 'append' })
  b.push('turn/start', { turn: 1 })
  b.push('user/message', { content: 'please fix the parser' }, { surfaceOp: 'append' })
  b.push('step/start', { turn: 1, step: 1 })
  const first = b.now() + 100
  b.push('assistant/message', {
    content: '',
    toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
    usage: { promptTokens: 200, completionTokens: 20, cachedTokens: 100 },
    durationMs: 1_000,
    stream: [
      { time: first - 1_000, chunk: { type: 'message_start', id: 'm' } },
      { time: first - 700, chunk: { type: 'reasoning_delta', id: 'm', delta: 'think' } },
      { time: first - 400, chunk: { type: 'reasoning_delta', id: 'm', delta: 'more' } },
      { time: first - 300, chunk: { type: 'toolcall_start', id: 'm', index: 0, name: 'read' } },
    ],
  }, { surfaceOp: 'append' }, first)
  b.push('tool/call', { id: 'c1', name: 'read', arguments: { path: 'a.ts' } })
  b.push('tool/result', { id: 'r1', toolCallId: 'c1', name: 'read', ok: true, output: text(400), durationMs: 250 }, { surfaceOp: 'append' })
  b.push('step/end', { turn: 1, step: 1 })
  b.push('step/start', { turn: 1, step: 2 })
  b.push('assistant/message', { content: text(30), usage: { promptTokens: 650, completionTokens: 40, cachedTokens: 600 }, durationMs: 500 }, { surfaceOp: 'append' })
  b.push('step/end', { turn: 1, step: 2 })
  b.push('turn/end', { turn: 1 })
  return b
}

describe('session context report', () => {
  it('counts turns, steps, inputs and tools, and prices each request', () => {
    const report = sessionContextReport(session().events, config)
    expect(report.title).toBe('Fix the parser')
    expect(report.stats).toMatchObject({ turns: 1, steps: 2, userInputs: 1, toolCalls: 1, toolErrors: 0, promptTokens: 850, completionTokens: 60, cachedTokens: 700, pricedSteps: 2 })
    expect(report.stats.cacheHitRate).toBeCloseTo(700 / 850)
    expect(report.stats.cost?.[0]?.currency).toBe('CNY')
    expect(report.steps.map(step => [step.turn, step.step])).toEqual([[1, 1], [1, 2]])
  })

  it('estimates each request from the surface before its reply', () => {
    const [first, second] = sessionContextReport(session().events, config).steps
    // The system message on the surface is the system prompt; the header copy is not counted twice.
    expect(first!.estimate.system).toBe(50)
    expect(first!.estimate.tools).toBeGreaterThan(20)
    expect(first!.estimate.results).toBe(0)
    expect(second!.estimate.results).toBeGreaterThanOrEqual(400)
    expect(second!.estimate.assistant).toBeGreaterThan(0)
  })

  it('splits billed tokens so they add up to what the provider billed', () => {
    const report = sessionContextReport(session().events, config)
    expect(compositionTotal(report.billed.composition)).toBeCloseTo(850, -1)
    expect(report.billed.output).toBe(60)
  })

  it('reads the current context as the composer does, against the route window', () => {
    const report = sessionContextReport(session().events, config, { window: () => 10_000 })
    expect(report.current).toMatchObject({ tokens: 650, source: 'provider' })
    expect(report.window).toBe(10_000)
    expect(report.compactAt).toBeCloseTo(0.75)
  })

  it('splits model time into waiting, thinking and responding, plus tool runs', () => {
    const { timing } = sessionContextReport(session().events, config)
    expect(timing.modelCalls).toBe(2)
    expect(timing.toolRuns).toBe(1)
    expect(timing.toolMs).toBe(250)
    expect(timing.waitingMs).toBe(300)
    expect(timing.thinkingMs).toBe(400)
    expect(timing.respondingMs).toBe(300 + 500)
    expect(timing.activeMs).toBeGreaterThanOrEqual(timing.waitingMs + timing.thinkingMs + timing.respondingMs + timing.toolMs)
  })

  it('gives each tool the requests that read its results, and counts its images', () => {
    const b = session()
    b.push('turn/start', { turn: 2 })
    b.push('user/message', { content: 'click it' }, { surfaceOp: 'append' })
    b.push('assistant/message', {
      content: '',
      toolCalls: [{ id: 'c2', name: 'computer_screenshot', arguments: {} }, { id: 'c3', name: 'computer_click', arguments: { x: 1, y: 2 } }],
      usage: { promptTokens: 700, completionTokens: 10 },
    }, { surfaceOp: 'append' })
    b.push('tool/result', { id: 'r2', toolCallId: 'c2', name: 'computer_screenshot', ok: true, output: 'shot', durationMs: 90, attachments: [{ type: 'image', mediaType: 'image/png', data: 'QUJDRA==' }] }, { surfaceOp: 'append' })
    b.push('tool/result', { id: 'r3', toolCallId: 'c3', name: 'computer_click', ok: false, error: { message: 'gone' }, durationMs: 10 }, { surfaceOp: 'append' })
    b.push('assistant/message', { content: 'done', usage: { promptTokens: 1_000, completionTokens: 30, cachedTokens: 400 } }, { surfaceOp: 'append' })
    b.push('turn/end', { turn: 2 })
    const { tools } = sessionContextReport(b.events, config)
    expect(tools.map(tool => tool.name)).toEqual(['read', 'computer_click', 'computer_screenshot'])
    expect(tools[0]).toMatchObject({ calls: 1, promptTokens: 650, cachedTokens: 600, completionTokens: 40, images: 0 })
    const shot = tools.find(tool => tool.name === 'computer_screenshot')!
    expect(shot).toMatchObject({ calls: 1, failed: 0, durationMs: 90, images: 1, imageBytes: 4, promptTokens: 500, cachedTokens: 200, completionTokens: 15 })
    expect(shot.cost?.[0]).toMatchObject({ currency: 'CNY' })
    expect(tools.find(tool => tool.name === 'computer_click')).toMatchObject({ calls: 1, failed: 1, images: 0, promptTokens: 500 })
  })

  it('counts a plugin’s nudge as injected context, not as something you wrote', () => {
    const b = session()
    b.push('user/message', { content: text(30), name: 'plugin:continue' }, { surfaceOp: 'append' })
    b.push('assistant/message', { content: 'ok', usage: { promptTokens: 700, completionTokens: 2 } }, { surfaceOp: 'append' })
    const report = sessionContextReport(b.events, config)
    expect(report.stats.userInputs).toBe(1)
    expect(report.lastMessage).toBe('please fix the parser')
    expect(report.steps.at(-1)!.estimate.injected).toBe(30)
  })

  it('counts a compaction summary as injected context and marks the next step', () => {
    const b = session()
    const checkpoint = b.push('checkpoint', {
      messages: [{ role: 'system', content: text(50) }, { role: 'user', content: `Summary: ${text(40)}` }],
      summary: `Summary: ${text(40)}`,
      tokensBefore: 900,
      surfaceOp: { op: 'replace', start: 4, end: 15 },
    })
    expect(checkpoint.type).toBe('checkpoint')
    b.push('turn/start', { turn: 2 })
    b.push('user/message', { content: 'and the tests' }, { surfaceOp: 'append' })
    b.push('assistant/message', { content: 'done', usage: { promptTokens: 160, completionTokens: 5 } }, { surfaceOp: 'append' })
    b.push('turn/end', { turn: 2 })
    const report = sessionContextReport(b.events, config)
    const last = report.steps.at(-1)!
    expect(report.stats.compactions).toBe(1)
    expect(last.compacted).toBe(true)
    expect(last.turn).toBe(2)
    expect(last.estimate.results).toBe(0)
    expect(last.estimate.injected).toBeGreaterThanOrEqual(40)
  })
})

describe('context insights', () => {
  it('rolls sessions up for the picked range and keeps the daily series', () => {
    const now = new Date(2026, 9, 21, 15).getTime()
    const day = 24 * 60 * 60 * 1000
    const recent = sessionContextReport(session(now - 3_600_000).events, config)
    const old = sessionContextReport(session(now - 40 * day).events, config)
    const sources: InsightsSource[] = [
      { id: 'a', kind: 'session', report: recent },
      { id: 'b', kind: 'thread', projectId: 'p', threadId: 't', report: old },
    ]
    const month = contextInsights(sources, '30d', now)
    expect(month.sessionCount).toBe(2)
    expect(month.activeSessions).toBe(1)
    expect(month.sessions.map(item => item.id)).toEqual(['a'])
    expect(month.totals).toMatchObject({ promptTokens: 850, completionTokens: 60, turns: 1, steps: 2, toolCalls: 1, pricedSessions: 1 })
    expect(month.week).toHaveLength(7)
    expect(month.week.at(-1)!.tokens).toBe(910)
    expect(month.activity).toHaveLength(84)

    const all = contextInsights(sources, 'all', now)
    expect(all.activeSessions).toBe(2)
    expect(all.totals.promptTokens).toBe(1700)
    expect(all.sessions.find(item => item.id === 'b')).toMatchObject({ kind: 'thread', projectId: 'p', threadId: 't' })
  })
})

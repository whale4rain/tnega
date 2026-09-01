import { describe, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'

import {
  PlanGenerationError,
  generatePlan,
  parsePlanResponse,
  planToContext,
} from '../src/plan.js'

describe('parsePlanResponse', () => {
  it('parses plain JSON into a pending plan', () => {
    const plan = parsePlanResponse(JSON.stringify({
      summary: 'Fix the build',
      items: [
        { title: 'Reproduce the failure' },
        { title: 'Patch the config', detail: 'check tsconfig' },
      ],
    }))

    expect(plan).toEqual({
      summary: 'Fix the build',
      status: 'pending',
      items: [
        { id: 'plan-1', title: 'Reproduce the failure', status: 'pending' },
        {
          id: 'plan-2',
          title: 'Patch the config',
          detail: 'check tsconfig',
          status: 'pending',
        },
      ],
    })
  })

  it('parses a fenced JSON block', () => {
    const plan = parsePlanResponse('```json\n{"items":[{"title":"one"},{"title":"two"}]}\n```')
    expect(plan.items).toHaveLength(2)
    expect(plan.items.map(item => item.title)).toEqual(['one', 'two'])
  })

  it('extracts an embedded JSON object from prose', () => {
    const plan = parsePlanResponse(
      'Sure, here is the implementation plan:\n{"summary":"Ship it","items":[{"title":"one"}]}',
    )
    expect(plan.summary).toBe('Ship it')
    expect(plan.items[0]?.title).toBe('one')
  })

  it('trims titles and detail and omits empty summary', () => {
    const plan = parsePlanResponse(JSON.stringify({
      summary: '  ',
      items: [{ title: '  run tests  ' }],
    }))
    expect(plan.summary).toBeUndefined()
    expect(plan.items[0]?.title).toBe('run tests')
  })

  it('rejects non-JSON and malformed shapes', () => {
    expect(() => parsePlanResponse('not json')).toThrow(PlanGenerationError)
    expect(() => parsePlanResponse('{"summary":"no items"}')).toThrow(/non-empty items/)
    expect(() => parsePlanResponse('{"items":[{"detail":"no title"}]}')).toThrow(/requires a title/)
    expect(() => parsePlanResponse('{"items":[42]}')).toThrow(/must be an object/)
  })
})

describe('planToContext', () => {
  it('serializes the plan as context text', () => {
    const text = planToContext({
      summary: 'Ship the feature',
      status: 'pending',
      items: [
        { id: 'plan-1', title: 'Design', status: 'pending' },
        { id: 'plan-2', title: 'Implement', status: 'pending' },
      ],
    })
    expect(text).toContain('Summary: Ship the feature')
    expect(text).toContain('1. Design')
    expect(text).toContain('2. Implement')
  })
})

describe('generatePlan', () => {
  it('asks the adapter with the planning prompt and parses its answer', async () => {
    const seen: Array<{ messages: unknown; tools: unknown }> = []
    const adapter: LLMAdapter = {
      async complete(messages, tools, options) {
        seen.push({ messages, tools })
        expect(options.maxSteps).toBe(1)
        return {
          content: JSON.stringify({ items: [{ title: 'Implement' }] }),
          finishReason: 'stop',
        }
      },
    }

    const plan = await generatePlan(adapter, [{ role: 'user', content: 'build it' }])
    expect(plan.items[0]?.title).toBe('Implement')
    expect(seen[0]?.messages).toMatchObject([
      { role: 'system' },
      { role: 'user', content: 'build it' },
    ])
    expect(seen[0]?.tools).toEqual([])
  })

  it('throws when the adapter returns no content', async () => {
    const adapter: LLMAdapter = {
      async complete() {
        return { finishReason: 'error' }
      },
    }
    await expect(generatePlan(adapter, [])).rejects.toThrow(PlanGenerationError)
  })

  it('retries with a correction prompt when the first answer is not JSON', async () => {
    const calls: Array<{ messages: ModelMessage[] }> = []
    const adapter: LLMAdapter = {
      async complete(messages) {
        calls.push({ messages: messages as ModelMessage[] })
        if (calls.length === 1) return { content: 'three.', finishReason: 'stop' }
        return {
          content: JSON.stringify({ items: [{ title: 'Reply with three' }] }),
          finishReason: 'stop',
        }
      },
    }

    const plan = await generatePlan(adapter, [{ role: 'user', content: 'reply three' }])
    expect(plan.items[0]?.title).toBe('Reply with three')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.messages).toMatchObject([
      { role: 'system', content: expect.stringContaining('planning assistant') },
      { role: 'user', content: 'reply three' },
      { role: 'assistant', content: 'three.' },
      { role: 'user', content: expect.stringContaining('was not a valid plan JSON') },
    ])
  })

  it('throws after exhausting plan correction retries', async () => {
    const adapter: LLMAdapter = {
      async complete() {
        return { content: 'still not json', finishReason: 'stop' }
      },
    }

    await expect(generatePlan(adapter, [])).rejects.toThrow(/not valid JSON/)
  })
})

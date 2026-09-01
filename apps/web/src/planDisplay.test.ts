import { describe, expect, it } from 'vitest'
import type { PlanPayload, SessionEvent, StreamEvent } from './types'
import {
  applyPlanStreamEvent,
  formatSlashMessage,
  formatSlashMetaEvent,
  formatSlashResult,
  latestPlanFromEvents,
  planFromPayload,
  planStatusText,
  readSlashMetaEvent,
  slashPromptParts,
} from './planDisplay'

function planEvent(payload: PlanPayload): SessionEvent {
  return {
    id: 'plan-event',
    seq: 1,
    ts: 1,
    type: 'plan',
    payload,
  }
}

describe('planFromPayload', () => {
  it('builds a display plan from a payload', () => {
    const plan = planFromPayload({
      summary: 'implement the endpoint',
      status: 'running',
      items: [
        { id: 'plan-1', title: 'inspect', status: 'done', detail: 'read the routes' },
        { id: 'plan-2', title: 'write tests', status: 'pending' },
      ],
    })
    expect(plan).toMatchObject({
      summary: 'implement the endpoint',
      status: 'running',
      items: [
        { id: 'plan-1', title: 'inspect', status: 'done', detail: 'read the routes' },
        { id: 'plan-2', title: 'write tests', status: 'pending' },
      ],
    })
  })

  it('normalizes unknown item statuses to pending', () => {
    const plan = planFromPayload({
      items: [
        { id: 'plan-1', title: 'x', status: 'done' },
        { id: 'plan-2', title: 'y', status: 'weird' as never },
      ],
    })
    expect(plan?.items[1]?.status).toBe('pending')
  })

  it('returns undefined for empty plans', () => {
    expect(planFromPayload({ items: [] })).toBeUndefined()
    expect(planFromPayload(undefined)).toBeUndefined()
  })
})

describe('latestPlanFromEvents', () => {
  it('returns the most recent plan event', () => {
    const events: SessionEvent[] = [
      planEvent({ items: [{ id: 'a', title: 'first', status: 'pending' }], status: 'pending' }),
      planEvent({
        items: [
          { id: 'b', title: 'second', status: 'pending' },
          { id: 'c', title: 'third', status: 'failed' },
        ],
        status: 'failed',
      }),
    ]
    expect(latestPlanFromEvents(events)?.items.map(item => item.id)).toEqual(['b', 'c'])
    expect(latestPlanFromEvents(events)?.status).toBe('failed')
  })

  it('returns undefined without plan events', () => {
    expect(latestPlanFromEvents([])).toBeUndefined()
  })
})

describe('applyPlanStreamEvent', () => {
  it('sets the plan from plan/items and updates items from plan/item', () => {
    const itemsEvent: StreamEvent = {
      type: 'plan/items',
      plan: {
        summary: 'plan',
        status: 'pending',
        items: [
          { id: 'plan-1', title: 'a', status: 'pending' },
          { id: 'plan-2', title: 'b', status: 'pending' },
        ],
      },
    }
    const next = applyPlanStreamEvent(undefined, itemsEvent)
    expect(next?.items).toHaveLength(2)
    const itemEvent: StreamEvent = {
      type: 'plan/item',
      item: { id: 'plan-1', title: 'a', status: 'done' },
    }
    const updated = applyPlanStreamEvent(next, itemEvent)
    expect(updated?.status).toBe('running')
    expect(updated?.items[0]?.status).toBe('done')
    expect(updated?.items[1]?.status).toBe('pending')
  })

  it('marks the whole plan done from plan/done', () => {
    const before = planFromPayload({
      items: [{ id: 'plan-1', title: 'a', status: 'pending' }],
      status: 'running',
    })
    const doneEvent: StreamEvent = {
      type: 'plan/done',
      plan: {
        items: [{ id: 'plan-1', title: 'a', status: 'done' }],
        status: 'done',
      },
    }
    expect(applyPlanStreamEvent(before, doneEvent)?.status).toBe('done')
  })
})

describe('planStatusText', () => {
  it('summarizes plan status', () => {
    expect(planStatusText({
      items: [
        { id: '1', title: 'a', status: 'done' },
        { id: '2', title: 'b', status: 'pending' },
      ],
      status: 'running',
    })).toBe('running')
    expect(planStatusText({
      items: [{ id: '1', title: 'a', status: 'done' }],
      status: 'done',
    })).toBe('done')
    expect(planStatusText(undefined)).toBe('')
  })
})

describe('slashPromptParts', () => {
  it('parses slash commands with args', () => {
    expect(slashPromptParts('/mode plan')).toEqual({ name: '/mode', args: ['plan'] })
    expect(slashPromptParts('/skills')).toEqual({ name: '/skills', args: [] })
    expect(slashPromptParts('write tests')).toBeNull()
  })
})

describe('formatSlashResult', () => {
  it('formats text and json results', () => {
    expect(formatSlashResult({ kind: 'text', text: 'hello' })).toBe('hello')
    expect(formatSlashResult({ kind: 'json', value: { modes: ['auto'] } }))
      .toBe('{\n  "modes": [\n    "auto"\n  ]\n}')
  })
})

describe('formatSlashMessage', () => {
  it('includes the command and formatted result', () => {
    expect(formatSlashMessage('/skills', [], { kind: 'text', text: 'hello' }))
      .toBe('/skills\n\nhello')
    expect(formatSlashMessage('/skills', ['fixture'], {
      kind: 'json',
      value: { skills: ['fixture'] },
    })).toBe('/skills fixture\n\n{\n  "skills": [\n    "fixture"\n  ]\n}')
  })
})

describe('formatSlashMetaEvent', () => {
  it('renders persisted slash meta events as chat content', () => {
    const event: SessionEvent = {
      id: 'slash-event',
      seq: 2,
      ts: 2,
      type: 'meta',
      payload: {
        kind: 'slash',
        command: '/skills',
        args: [],
        result: { kind: 'json', value: { skills: ['fixture'] } },
      },
    }
    expect(formatSlashMetaEvent(event)).toBe(
      '/skills\n\n{\n  "skills": [\n    "fixture"\n  ]\n}',
    )
  })

  it('ignores unrelated meta events', () => {
    const event: SessionEvent = {
      id: 'resume-event',
      seq: 2,
      ts: 2,
      type: 'meta',
      payload: { kind: 'resume' },
    }
    expect(formatSlashMetaEvent(event)).toBeNull()
  })
})

describe('readSlashMetaEvent', () => {
  it('reads persisted slash meta payloads', () => {
    const event: SessionEvent = {
      id: 'slash-event',
      seq: 2,
      ts: 2,
      type: 'meta',
      payload: {
        kind: 'slash',
        command: '/mode',
        args: ['plan'],
        result: { kind: 'json', value: { current: 'plan' } },
      },
    }
    expect(readSlashMetaEvent(event)).toEqual({
      kind: 'slash',
      command: '/mode',
      args: ['plan'],
      result: { kind: 'json', value: { current: 'plan' } },
    })
  })

  it('supports text slash results', () => {
    const event: SessionEvent = {
      id: 'slash-event',
      seq: 2,
      ts: 2,
      type: 'meta',
      payload: {
        kind: 'slash',
        command: '/skills',
        args: ['fixture'],
        result: { kind: 'text', text: 'unknown skill: fixture' },
      },
    }
    expect(readSlashMetaEvent(event)).toMatchObject({
      command: '/skills',
      result: { kind: 'text', text: 'unknown skill: fixture' },
    })
  })

  it('ignores unrelated or malformed meta events', () => {
    expect(readSlashMetaEvent({
      id: 'resume-event',
      seq: 2,
      ts: 2,
      type: 'meta',
      payload: { kind: 'resume' },
    })).toBeNull()
    expect(readSlashMetaEvent({
      id: 'bad-event',
      seq: 3,
      ts: 3,
      type: 'meta',
      payload: { kind: 'slash', command: '/mode' },
    })).toBeNull()
    const messageEvent = {
      id: 'msg-event',
      seq: 4,
      ts: 4,
      type: 'user/message',
      payload: {
        kind: 'slash',
        command: '/mode',
        args: [],
        result: { kind: 'text', text: 'x' },
      },
    } as unknown as SessionEvent
    expect(readSlashMetaEvent(messageEvent)).toBeNull()
  })
})

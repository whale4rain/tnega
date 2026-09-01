import { describe, expect, it } from 'vitest'
import {
  formatToolGroupNames,
  formatToolGroupStatus,
  groupToolMessages,
  summarizeToolGroup,
} from '../apps/web/src/toolGroups.js'
import type { DisplayMessage } from '../apps/web/src/types.js'

function toolMessage(
  id: string,
  name: string,
  status: 'pending' | 'done' = 'done',
  ok?: boolean,
): DisplayMessage {
  return {
    id,
    role: 'tool',
    content: '',
    tool: {
      callId: id,
      name,
      argumentsText: '{}',
      status,
      ...(ok === undefined ? {} : { ok }),
    },
  }
}

describe('groupToolMessages', () => {
  it('groups consecutive tool messages and keeps non-tool source indexes', () => {
    const user: DisplayMessage = { id: 'u1', role: 'user', content: 'hi' }
    const first = toolMessage('t1', 'bash')
    const second = toolMessage('t2', 'read')
    const assistant: DisplayMessage = { id: 'a1', role: 'assistant', content: 'done' }

    expect(groupToolMessages([user, first, second, assistant])).toEqual([
      { kind: 'message', message: user, sourceIndex: 0 },
      { kind: 'tools', tools: [first, second] },
      { kind: 'message', message: assistant, sourceIndex: 3 },
    ])
  })

  it('splits groups when a non-tool message appears between tools', () => {
    const first = toolMessage('t1', 'bash')
    const user: DisplayMessage = { id: 'u1', role: 'user', content: 'again' }
    const second = toolMessage('t2', 'read')

    expect(groupToolMessages([first, user, second])).toEqual([
      { kind: 'tools', tools: [first] },
      { kind: 'message', message: user, sourceIndex: 1 },
      { kind: 'tools', tools: [second] },
    ])
  })

  it('returns an empty list for no messages', () => {
    expect(groupToolMessages([])).toEqual([])
  })

  it('wraps a single tool message into a group', () => {
    const tool = toolMessage('t1', 'bash')
    expect(groupToolMessages([tool])).toEqual([
      { kind: 'tools', tools: [tool] },
    ])
  })
})

describe('summarizeToolGroup', () => {
  it('counts statuses and collapses duplicate tool names', () => {
    const summary = summarizeToolGroup([
      toolMessage('t1', 'bash', 'done', true),
      toolMessage('t2', 'bash', 'done', false),
      toolMessage('t3', 'read', 'pending'),
      toolMessage('t4', 'rg', 'done'),
    ])

    expect(summary).toEqual({
      count: 4,
      names: [
        { name: 'bash', count: 2 },
        { name: 'read', count: 1 },
        { name: 'rg', count: 1 },
      ],
      ok: 1,
      failed: 1,
      running: 1,
      done: 1,
    })
  })
})

describe('tool group formatting', () => {
  it('formats names with duplicate counts', () => {
    expect(formatToolGroupNames([
      { name: 'bash', count: 2 },
      { name: 'rg', count: 1 },
    ])).toBe('bash x2, rg')
  })

  it('formats status text in a stable order', () => {
    expect(formatToolGroupStatus({
      count: 4,
      names: [],
      ok: 1,
      failed: 2,
      running: 1,
      done: 0,
    })).toBe('1 running / 1 ok / 2 err')
  })

  it('falls back to a count when no status is known', () => {
    expect(formatToolGroupStatus({
      count: 3,
      names: [],
      ok: 0,
      failed: 0,
      running: 0,
      done: 0,
    })).toBe('3 tools')
  })
})

import { describe, expect, it } from 'vitest'
import { groupToolMessages } from '../apps/web/src/toolGroups.js'
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

import { describe, expect, it } from 'vitest'
import { groupToolMessages } from './toolGroups'
import type { DisplayMessage } from './types'

const tool: DisplayMessage = { id: 't1', role: 'tool', content: '', tool: { callId: 'c1', name: 'shell', argumentsText: '{}', status: 'done', ok: true } }
const empty: DisplayMessage = { id: 'a1', role: 'assistant', content: '', finishReason: 'tool_calls' }

describe('tool activity grouping', () => {
  it('merges calls separated by blank streaming assistant messages', () => {
    const second = { ...tool, id: 't2' }
    expect(groupToolMessages([empty, tool, { ...empty, content: '  ' }, second])).toEqual([{ kind: 'tools', tools: [tool, second] }])
  })
  it('preserves actual commentary and its original source index', () => {
    const prose: DisplayMessage = { id: 'a2', role: 'assistant', content: 'Now running tests.' }
    expect(groupToolMessages([empty, tool, prose, tool])).toEqual([
      { kind: 'tools', tools: [tool] }, { kind: 'message', message: prose, sourceIndex: 2 }, { kind: 'tools', tools: [tool] },
    ])
  })
  it('never hides failure, retry or interruption states', () => {
    const failed: DisplayMessage = { ...empty, endState: { error: { message: 'Connection failed' } } }
    const interrupted = { ...empty, interrupted: true }
    expect(groupToolMessages([tool, failed, interrupted])).toHaveLength(3)
  })
  it('keeps a standalone thinking placeholder but folds one into active tools', () => {
    const pending = { ...empty, pending: true }
    expect(groupToolMessages([pending])).toEqual([{ kind: 'message', message: pending, sourceIndex: 0 }])
    expect(groupToolMessages([tool, pending])).toEqual([{ kind: 'tools', tools: [tool] }])
  })
})

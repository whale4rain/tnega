import { describe, expect, it } from 'vitest'
import { toolBox, PROJECT_MESSAGE_MAX_CHARS } from '../src/index.js'

function harness() {
  const sent: unknown[] = []
  const registered: Array<{ execute: (input: unknown, options: { agentId?: string }) => Promise<unknown> }> = []
  const services: Record<string, unknown> = {
    box: { send: async (envelope: unknown) => { sent.push(envelope) } },
    threads: { get: async (id: string) => ({ id }) },
    tools: { register: (tool: { execute: (input: unknown, options: { agentId?: string }) => Promise<unknown> }) => { registered.push(tool) } },
  }
  toolBox.apply({ get: (name: string) => services[name], ...services } as never)
  return { sent, tool: registered[0]! }
}

describe('send_project_message', () => {
  it('posts a short bubble to the room', async () => {
    const { sent, tool } = harness()
    await tool.execute({ message: 'Started a thread for this.' }, { agentId: 'c' })
    expect(sent).toHaveLength(1)
  })

  it('refuses a report-sized bubble and points at artifacts', async () => {
    const { sent, tool } = harness()
    await expect(tool.execute({ message: 'x'.repeat(PROJECT_MESSAGE_MAX_CHARS + 1) }, { agentId: 'c' }))
      .rejects.toThrow(/publish_artifact/u)
    expect(sent).toHaveLength(0)
  })
})

describe('react_to_message', () => {
  function reacting(timeline: Array<{ messageId: string; kind: string }>, received: string[]) {
    const reactions: unknown[] = []
    const registered: Array<{ schema: { name: string }; execute: (input: unknown, options: { agentId?: string }) => Promise<unknown> }> = []
    const services: Record<string, unknown> = {
      box: { timeline: async () => timeline, react: async (input: unknown) => { reactions.push(input) } },
      threads: { activate: async () => ({ session: { read: async () => received.map(id => ({ type: 'user/message', payload: { name: `box:${id}` } })) } }) },
      tools: { register: (tool: (typeof registered)[number]) => { registered.push(tool) } },
    }
    toolBox.apply({ get: (name: string) => services[name], ...services } as never)
    return { reactions, tool: registered.find(tool => tool.schema.name === 'react_to_message')! }
  }

  it('reacts to the newest user message this Agent received', async () => {
    const { reactions, tool } = reacting([
      { messageId: 'old', kind: 'user-message' },
      { messageId: 'brief', kind: 'dispatch' },
      { messageId: 'new', kind: 'user-thread' },
      { messageId: 'elsewhere', kind: 'user-message' },
    ], ['old', 'brief', 'new'])
    await tool.execute({ emoji: '👍' }, { agentId: 'worker' })
    expect(reactions).toEqual([{ messageId: 'new', emoji: '👍', by: { kind: 'agent', id: 'worker' } }])
  })

  it('says so when the user has not written to it yet', async () => {
    const { reactions, tool } = reacting([{ messageId: 'brief', kind: 'dispatch' }], ['brief'])
    await expect(tool.execute({ emoji: '👍' }, { agentId: 'worker' })).rejects.toThrow(/no message from the user/u)
    expect(reactions).toEqual([])
  })
})

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
  toolBox.apply({ get: (name: string) => services[name] } as never)
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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentLoop, LLMAdapter } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import { expect, it } from 'vitest'
import { createAgentRuntime } from '../src/commands.js'
import { personaFor } from '../src/work.js'

it('supplies the default persona to model requests without replacing custom agent instructions', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-persona-'))
  const calls: Array<readonly ModelMessage[]> = []
  const llm: LLMAdapter = { async complete(messages) {
    calls.push(messages)
    return { content: 'Done', finishReason: 'stop' }
  } }
  try {
    const runtime = await createAgentRuntime({ cwd: workspace, sessionFile: join(workspace, 'general.jsonl'), llm })
    try {
      const loop: AgentLoop = runtime.root.get('agentLoop')
      await loop({ text: 'Check this task' })
      const persona = personaFor('general')
      expect(persona).toBeTruthy()
      expect(calls.at(-1)?.filter(message => message.role === 'system').map(message => message.content).join('\n')).toContain(persona)
    } finally { await runtime.dispose() }
    const custom = await createAgentRuntime({ cwd: workspace, sessionFile: join(workspace, 'custom.jsonl'), llm,
      agent: { name: 'custom', system: 'Return only a single JSON object.' },
    })
    try {
      const loop: AgentLoop = custom.root.get('agentLoop')
      await loop({ text: 'Check this task' })
      const instructions = calls.at(-1)?.filter(message => message.role === 'system').map(message => message.content).join('\n')
      expect(instructions).toContain('Return only a single JSON object.')
      expect(instructions).not.toContain(personaFor('general'))
    } finally { await custom.dispose() }
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

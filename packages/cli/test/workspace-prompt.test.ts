import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { agent, systemPrompt, type AgentService, type LLMAdapter } from '@tnega/agent'
import { memoryLocal } from '@tnega/memory-local'
import { toolMemory } from '@tnega/tool-memory'
import { SessionLog } from '@tnega/session'
import { tools, type ToolsService } from '@tnega/tools'
import { readWorkspacePrompt, writeWorkspacePrompt, workspacePrompt } from '../src/workspace-prompt.js'

it('persists workspace instructions, refreshes assembly and can clear them', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-prompt-'))
  const root = new Context()
  try {
    await root.plugin(systemPrompt)
    await root.plugin(workspacePrompt, { workspace })
    expect(await readWorkspacePrompt(workspace)).toBe('')
    await writeWorkspacePrompt(workspace, '  Answer in Chinese.  ')
    expect((await root.get('systemPrompt').assemble()).text).toContain('Answer in Chinese.')
    expect(await readWorkspacePrompt(workspace)).toBe('Answer in Chinese.')
    await writeWorkspacePrompt(workspace, '')
    expect((await root.get('systemPrompt').assemble()).text).not.toContain('Answer in Chinese.')
    await expect(writeWorkspacePrompt(workspace, 'x'.repeat(32001))).rejects.toThrow('32000')
  } finally {
    await root.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})

it.each([false, true])('shares a single dynamic header with memory across steps and runs (memoryFirst=%s)', async memoryFirst => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-prompt-memory-'))
  const root = new Context()
  const session = new SessionLog(join(workspace, 'session.jsonl'))
  try {
    await root.plugin(systemPrompt)
    await root.plugin(tools)
    await root.plugin(memoryLocal, { cwd: workspace, globalFile: join(workspace, 'global.md') })
    if (memoryFirst) await root.plugin(toolMemory)
    await root.plugin(workspacePrompt, { workspace })
    if (!memoryFirst) await root.plugin(toolMemory)
    await root.memory.writeProject('- Use pnpm')
    await writeWorkspacePrompt(workspace, 'Answer in Chinese.')
    await session.append('system/message', { content: 'Coding persona' })
    const registry: ToolsService = root.get('tools')
    registry.register({ schema: { name: 'check', description: 'Check', parameters: {} }, async execute() { return 'ok' } })
    const requests: string[][] = []
    const llm: LLMAdapter = { async complete(messages) {
      requests.push(messages.map(message => message.content))
      return requests.length % 2 === 1
        ? { content: '', toolCalls: [{ id: `check-${requests.length}`, name: 'check', arguments: {} }], finishReason: 'tool_calls' }
        : { content: 'done', finishReason: 'stop' }
    } }
    root.provide('session', session)
    await root.plugin(agent, { session, llm })
    const service: AgentService = root.get('agent')
    for (const memory of ['- Use pnpm', '- Run lint']) {
      await root.memory.writeProject(memory)
      await service.run({ messages: [...await session.deriveMessages(), { role: 'user', content: 'go' }] })
      for (const request of requests.slice(-2)) {
        expect(request[0]).toContain(memory)
        expect(request[0]).toContain('Answer in Chinese.')
        expect(request[1]).toBe('Coding persona')
        expect(request.join('\n').split('Persistent memory for this run:')).toHaveLength(2)
        expect(request.join('\n').split('<workspace-user-instructions>')).toHaveLength(2)
      }
    }
    expect(requests).toHaveLength(4)
    expect((await session.read()).filter(event => event.type === 'checkpoint')).toHaveLength(0)
    expect((await session.read()).filter(event => event.type === 'user/message').map(event => event.payload.content)).toEqual(['go', 'go'])
  } finally {
    await session.close()
    await root.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})

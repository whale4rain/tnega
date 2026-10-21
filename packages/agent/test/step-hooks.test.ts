import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { agents, type AgentRegistry, type AgentStepEndEvent, type AgentStepLimitsEvent, type LLMAdapter, type LLMCompletion } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const toolCall = (index: number): LLMCompletion => ({
  content: '', toolCalls: [{ id: `c${index}`, name: 'echo', arguments: { n: index } }], finishReason: 'tool_calls',
})

async function setup(reply: (index: number, names: string[]) => LLMCompletion, maxSteps?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-step-hooks-'))
  dirs.push(dir)
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  root.get('tools').register({
    schema: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { n: { type: 'number' } } } },
    execute: (input: unknown) => input,
  })
  let index = 0
  const llm: LLMAdapter = {
    async complete(messages) { return reply(index++, messages.map(message => message.name ?? message.role)) },
  }
  const registry = root.get('agents') as AgentRegistry
  const handle = await registry.create({ id: 'hooked', file: join(dir, 's.jsonl'), llm, ...(maxSteps ? { maxSteps } : {}) })
  return { root, handle, calls: () => index }
}

describe('agent step hooks', () => {
  it('lets a plugin fill in step limits the caller left unset, and falls back to 64', async () => {
    const { root, handle, calls } = await setup(toolCall)
    const seen: AgentStepLimitsEvent[] = []
    root.on('agent/step-limits', async (event: AgentStepLimitsEvent, next: () => Promise<AgentStepLimitsEvent>) => {
      seen.push({ ...event })
      const limits = await next()
      return { ...limits, maxSteps: limits.maxSteps ?? 3, maxTurns: limits.maxTurns ?? 3 }
    })
    await handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()
    expect(seen).toEqual([{ agentId: 'hooked' }])
    // The plugin's limit applies: no continuation plugin is mounted, so no extra step.
    expect(calls()).toBe(3)
    await handle.dispose()
  })

  it('keeps the caller\'s limit in the event', async () => {
    const { root, handle } = await setup(toolCall, 2)
    const seen: AgentStepLimitsEvent[] = []
    root.on('agent/step-limits', (event: AgentStepLimitsEvent) => { seen.push({ ...event }); return event })
    await handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()
    expect(seen[0]).toMatchObject({ agentId: 'hooked', maxSteps: 2 })
    await handle.dispose()
  })

  it('awaits step-end with the calls and results, and a steer there reaches the next step', async () => {
    const steps: AgentStepEndEvent[] = []
    const requests: string[][] = []
    const { root, handle } = await setup((index, names) => {
      requests.push(names)
      return index === 0 ? toolCall(0) : { content: 'done', finishReason: 'stop' }
    })
    root.on('agent/step-end', async (event: AgentStepEndEvent) => {
      steps.push(event)
      if (event.index === 0) await handle.agent.steer({ messages: [{ role: 'user', name: 'plugin:test', content: 'note' }] })
    })
    await handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()
    expect(steps.map(step => step.calls.map(({ call, result }) => [call.name, result.ok]))).toEqual([[['echo', true]], []])
    expect(steps[0]).toMatchObject({ agentId: 'hooked', index: 0 })
    expect(requests[1]?.at(-1)).toBe('plugin:test')
    await handle.dispose()
  })
})

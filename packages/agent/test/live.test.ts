import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { tools } from '@tnega/tools'

import {
  agents,
  DurableInbox,
  type AgentRegistry,
  type LiveAgent,
  type LLMAdapter,
  type LLMCompletion,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-live-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function mountRoot(
  llm: LLMAdapter = fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
): Promise<Context> {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  root.provide('agentFactoryLLM', llm)
  return root
}

function fakeLLM(sequence: readonly LLMCompletion[]): LLMAdapter {
  let index = 0
  return {
    async complete() {
      return sequence[Math.min(index++, sequence.length - 1)]!
    },
  }
}

async function createHandle(
  root: Context,
  file: string,
  llm?: LLMAdapter,
  owner?: string,
) {
  const registry = dynamic(root).agents as AgentRegistry
  return registry.create({
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    file,
    ...(owner ? { owner } : {}),
    llm: llm ?? (dynamic(root).agentFactoryLLM as LLMAdapter),
  })
}

describe('live agent registry', () => {
  it('creates, lists and disposes agents with lifecycle events', async () => {
    const root = await mountRoot()
    const events: string[] = []
    root.on('agent/created', () => events.push('created'))
    root.on('agent/disposed', () => events.push('disposed'))

    const handle = await createHandle(root, await tempFile('registry.jsonl'))
    const registry = dynamic(root).agents as AgentRegistry
    expect(registry.get(handle.agent.id)).toBe(handle.agent)
    expect(registry.list()).toHaveLength(1)
    expect(events).toEqual(['created'])

    await handle.dispose()
    expect(registry.get(handle.agent.id)).toBeUndefined()
    expect(events).toEqual(['created', 'disposed'])
  })

  it('wakes the driver and drains queued followups', async () => {
    const root = await mountRoot()
    const calls: string[] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        calls.push(messages.at(-1)?.content ?? '')
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('drain.jsonl'), llm)
    handle.agent.followup({ text: 'one' })
    handle.agent.followup({ text: 'two' })

    await handle.agent.whenIdle()
    expect(calls).toEqual(['one', 'two'])
  })

  it('claims steering input before ordinary followups', async () => {
    const root = await mountRoot()
    const calls: string[] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        calls.push(messages.at(-1)?.content ?? '')
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('steer.jsonl'), llm)
    handle.agent.followup({ text: 'queued' })
    handle.agent.steer({ text: 'urgent' })

    await handle.agent.whenIdle()
    expect(calls).toEqual(['urgent', 'queued'])
  })

  it('aborts the active run on cancel and reports a typed cause', async () => {
    const root = await mountRoot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const llm: LLMAdapter = {
      async complete(_messages, _tools, options) {
        await gate
        if (options?.signal?.aborted) {
          const cause = options.signal.reason
          throw cause && typeof cause === 'object'
            ? Object.assign(new Error('cancelled'), cause)
            : new Error('cancelled')
        }
        return { content: 'late', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('cancel.jsonl'), llm)
    handle.agent.followup({ text: 'long' })
    const running = new Promise<void>((resolve) => {
      root.on('agent/status', (event: { status: string; id: string }) => {
        if (event.status === 'running' && event.id === handle.agent.id) resolve()
      })
    })
    await running

    handle.agent.cancel({ type: 'user' })
    release()
    await handle.agent.whenIdle()
    expect(handle.agent.status).toBe('idle')
  })

  it('exposes roots and ownership for registry queries', async () => {
    const root = await mountRoot()
    const parent = await createHandle(root, await tempFile('owner-parent.jsonl'))
    const child = await createHandle(
      root,
      await tempFile('owner-child.jsonl'),
      undefined,
      parent.agent.id,
    )
    const registry = dynamic(root).agents as AgentRegistry
    expect(registry.roots()).toEqual([parent.agent])
    expect(registry.isOwnedBy(child.agent.id, parent.agent.id)).toBe(true)
    expect(registry.isOwnedBy(parent.agent.id, child.agent.id)).toBe(false)
  })
})

describe('live agent typing', () => {
  it('has LiveAgent surface types', async () => {
    const root = await mountRoot()
    const handle = await createHandle(root, await tempFile('types.jsonl'))
    const agent: LiveAgent = handle.agent
    expect(typeof agent.followup).toBe('function')
    expect(typeof agent.steer).toBe('function')
    expect(typeof agent.send).toBe('function')
    expect(typeof agent.inject).toBe('function')
    expect(typeof agent.cancel).toBe('function')
    expect(typeof agent.whenIdle).toBe('function')
    expect(agent.status).toBe('idle')
    await handle.dispose()
  })
})

describe('live agent resume', () => {
  it('restores durable pending work and continues draining', async () => {
    const file = await tempFile('resume.jsonl')
    const prior = new SessionLog(file)
    await prior.init()
    const priorInbox = new DurableInbox(prior)
    await priorInbox.insert({ text: 'pending' })
    await prior.flush()
    await prior.close()

    const root = await mountRoot()
    const calls: string[] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        calls.push(messages.at(-1)?.content ?? '')
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const registry = dynamic(root).agents as AgentRegistry
    const resumed = await registry.resume({
      id: 'resumed-agent',
      file,
      llm,
    })
    await resumed.agent.whenIdle()
    expect(calls).toEqual(['pending'])

    resumed.agent.followup({ text: 'after-resume' })
    await resumed.agent.whenIdle()
    expect(calls).toEqual(['pending', 'after-resume'])

    await resumed.dispose()
  })
})

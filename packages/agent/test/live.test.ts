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
  type DurableInboxMessage,
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
  setup?: (agentCtx: Context) => void,
) {
  const registry = dynamic(root).agents as AgentRegistry
  return registry.create({
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    file,
    ...(owner ? { owner } : {}),
    llm: llm ?? (dynamic(root).agentFactoryLLM as LLMAdapter),
    ...(setup ? { setup } : {}),
  })
}

async function waitForPending(
  agent: LiveAgent,
  text: string,
): Promise<DurableInboxMessage | undefined> {
  const timeoutAt = Date.now() + 1000
  while (Date.now() < timeoutAt) {
    const snapshot = agent.inbox.snapshot()
    const found = [...snapshot.nextTurn, ...snapshot.nextStep]
      .find(message => message.text === text)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return undefined
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
    const claimedTurns: number[] = []
    const sessionStarts: string[] = []
    root.on('agent/inbox/claimed', (payload: { turn?: number }) => {
      if (payload.turn !== undefined) claimedTurns.push(payload.turn)
    })
    root.on('agent/session-start', (payload: { source: string }) => {
      sessionStarts.push(payload.source)
    })
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
    expect(claimedTurns).toEqual([1, 2])
    expect(sessionStarts).toEqual(['startup'])
  })

  it('replaces and removes pending messages by id', async () => {
    const root = await mountRoot()
    const events: string[] = []
    const calls: string[] = []
    root.on('agent/inbox/inserted', () => events.push('inserted'))
    root.on('agent/inbox/discarded', () => events.push('discarded'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const llm: LLMAdapter = {
      async complete(messages, _tools, options) {
        if (calls.length === 0) {
          await gate
          if (options?.signal?.aborted) throw new Error('cancelled')
        }
        calls.push(messages.at(-1)?.content ?? '')
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('pending-mutate.jsonl'), llm)

    handle.agent.followup({ text: 'blocked' })
    await new Promise<void>((resolve) => {
      root.on('agent/status', (event: { status: string; id: string }) => {
        if (event.status === 'running' && event.id === handle.agent.id) resolve()
      })
    })

    handle.agent.followup({ text: 'to-remove' })
    const pending = await waitForPending(handle.agent, 'to-remove')
    expect(pending).toBeDefined()
    handle.agent.removeMessage(pending!.id)

    handle.agent.followup({ text: 'to-replace' })
    const second = await waitForPending(handle.agent, 'to-replace')
    expect(second).toBeDefined()
    handle.agent.replaceMessage(second!.id, { text: 'replaced' })

    release()
    await handle.agent.whenIdle()
    expect(calls).toEqual(['blocked', 'replaced'])
    expect(events.some(event => event === 'discarded')).toBe(true)
    expect(events.some(event => event === 'inserted')).toBe(true)
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

  it('runs maintenance while idle and follows it in whenIdle', async () => {
    const root = await mountRoot()
    const handle = await createHandle(root, await tempFile('maintenance.jsonl'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let sawSignal: AbortSignal | undefined

    const task = handle.agent.runMaintenance(async (signal) => {
      sawSignal = signal
      await gate
      return 42
    })
    let settled = false
    void task.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    expect(handle.agent.status).toBe('idle')
    expect(sawSignal?.aborted).toBe(false)

    release()
    await expect(task).resolves.toBe(42)
    expect(settled).toBe(true)
    await handle.dispose()
  })

  it('rejects maintenance while a run is busy', async () => {
    const root = await mountRoot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const llm: LLMAdapter = {
      async complete() {
        await gate
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('maintenance-busy.jsonl'), llm)
    handle.agent.followup({ text: 'busy' })
    await new Promise<void>((resolve) => {
      root.on('agent/status', (event: { status: string; id: string }) => {
        if (event.status === 'running' && event.id === handle.agent.id) resolve()
      })
    })

    expect(() => handle.agent.runMaintenance(async () => undefined)).toThrow(/busy/)
    release()
    await handle.agent.whenIdle()
    await handle.dispose()
  })

  it('reports failed run coordinates on agent/error', async () => {
    const root = await mountRoot()
    const errors: Array<{ turn?: number; step?: number }> = []
    root.on('agent/error', (payload: { turn?: number; step?: number }) => {
      errors.push({ ...(payload.turn !== undefined ? { turn: payload.turn } : {}), ...(payload.step !== undefined ? { step: payload.step } : {}) })
    })
    const llm: LLMAdapter = {
      async complete() {
        throw new Error('run exploded')
      },
    }
    const handle = await createHandle(root, await tempFile('run-error.jsonl'), llm)
    handle.agent.followup({ text: 'boom' })
    await handle.agent.whenIdle()
    expect(errors).toEqual([{ turn: 1, step: 0 }])
    await handle.dispose()
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

  it('runs setup against agentCtx and cleans its registrations on dispose', async () => {
    const root = await mountRoot()
    const order: string[] = []
    let setupCtx: Context | undefined
    const handle = await createHandle(
      root,
      await tempFile('setup-scope.jsonl'),
      fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
      undefined,
      (agentCtx) => {
        setupCtx = agentCtx
        order.push('setup')
        agentCtx.provide('agentSetupMarker', { from: 'setup' })
        agentCtx.on('agent-custom', () => order.push('custom-event'))
      },
    )
    expect(setupCtx).toBe(handle.agent.agentCtx)
    expect((handle.agent.agentCtx as unknown as {
      get(name: string): unknown
    }).get('agentSetupMarker')).toEqual({ from: 'setup' })

    handle.agent.agentCtx.emit('agent-custom')
    expect(order).toEqual(['setup', 'custom-event'])

    await handle.dispose()
    expect((handle.agent.agentCtx as unknown as {
      get(name: string): unknown
    }).get('agentSetupMarker')).toBeUndefined()
    handle.agent.agentCtx.emit('agent-custom')
    expect(order).toEqual(['setup', 'custom-event'])
  })

  it('rolls back a failed setup without registering the agent', async () => {
    const root = await mountRoot()
    const file = await tempFile('setup-fail.jsonl')
    const registry = dynamic(root).agents as AgentRegistry
    await expect(registry.create({
      id: 'setup-fail-agent',
      file,
      llm: fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
      setup: (agentCtx) => {
        agentCtx.provide('shouldRollback', true)
        throw new Error('setup exploded')
      },
    })).rejects.toThrow('setup exploded')

    expect(registry.get('setup-fail-agent')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('rolls back when the setup publication commit throws', async () => {
    const root = await mountRoot()
    const file = await tempFile('setup-commit-fail.jsonl')
    const registry = dynamic(root).agents as AgentRegistry
    await expect(registry.create({
      id: 'setup-commit-fail-agent',
      file,
      llm: fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
      setup: (agentCtx) => {
        agentCtx.provide('commitMarker', true)
        return {
          commit: () => {
            throw new Error('commit exploded')
          },
        }
      },
    })).rejects.toThrow('commit exploded')

    expect(registry.get('setup-commit-fail-agent')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
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
  it('persists identity and restores durable pending work on resume', async () => {
    const file = await tempFile('resume.jsonl')
    const prior = new SessionLog(file)
    await prior.init()
    const priorInbox = new DurableInbox(prior)
    await prior.append('meta', {
      kind: 'agent',
      agentId: 'resumed-agent',
      agentType: 'coding',
      mode: 'plan',
      title: 'Resume fixture',
      owner: 'root-agent',
      parentSessionId: 'parent-session',
      forkedAtMessageId: 'message-9',
      createdAt: 1,
    })
    await prior.append('request/header', {
      reason: 'initial',
      system: 'previous system',
      tools: [{ name: 'old_tool', description: 'old tool' }],
    })
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
    const sessionStarts: string[] = []
    root.on('agent/session-start', (payload: { source: string }) => {
      sessionStarts.push(payload.source)
    })
    const resumed = await registry.resume({
      id: 'resumed-agent',
      file,
      llm,
    })
    expect(sessionStarts).toEqual(['resume'])
    expect(resumed.agent.meta).toMatchObject({
      agentId: 'resumed-agent',
      agentType: 'coding',
      mode: 'plan',
      title: 'Resume fixture',
      owner: 'root-agent',
      parentSessionId: 'parent-session',
      forkedAtMessageId: 'message-9',
      createdAt: 1,
    })
    expect(resumed.agent.agentType).toBe('coding')
    expect(resumed.agent.mode).toBe('plan')
    expect(resumed.agent.owner).toBe('root-agent')
    expect(resumed.agent.parentSessionId).toBe('parent-session')
    await resumed.agent.whenIdle()
    expect(calls).toEqual(['pending'])

    const events = await resumed.agent.session.read()
    const headers = events.filter(event => event.type === 'request/header')
    expect((headers.at(-1)?.payload as { reason: string }).reason).toBe('resume')

    resumed.agent.followup({ text: 'after-resume' })
    await resumed.agent.whenIdle()
    expect(calls).toEqual(['pending', 'after-resume'])

    await resumed.dispose()
  })

  it('rejects a resume whose identity conflicts with the session meta', async () => {
    const file = await tempFile('resume-mismatch.jsonl')
    const prior = new SessionLog(file)
    await prior.init()
    await prior.append('meta', {
      kind: 'agent',
      agentId: 'stored-agent',
      agentType: 'general',
    })
    await prior.flush()
    await prior.close()

    const root = await mountRoot()
    const registry = dynamic(root).agents as AgentRegistry
    await expect(registry.resume({
      id: 'different-agent',
      file,
      llm: fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
    })).rejects.toThrow(/agent id mismatch/)

    await expect(registry.resume({
      id: 'stored-agent',
      file,
      agentType: 'coding',
      llm: fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
    })).rejects.toThrow(/agent type mismatch/)

    await expect(registry.resume({
      id: 'stored-agent',
      file,
      mode: 'execute',
      llm: fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
    })).rejects.toThrow(/agent mode mismatch/)
  })

  it('resume requires a stable session id', async () => {
    const root = await mountRoot()
    const registry = dynamic(root).agents as AgentRegistry
    await expect(registry.resume({
      file: await tempFile('resume-no-id.jsonl'),
      llm: fakeLLM([{ content: 'ok', finishReason: 'stop' }]),
    })).rejects.toThrow(/stable session id/)
  })
})

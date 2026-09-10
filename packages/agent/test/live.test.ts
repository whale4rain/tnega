import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { SessionLog, type ModelMessage } from '@tnega/session'
import { tools, ToolsService } from '@tnega/tools'

import {
  agents,
  DurableInbox,
  LlmService,
  SystemPromptService,
  type DurableInboxMessage,
  type AgentRegistry,
  type LiveAgent,
  type LLMAdapter,
  type LLMCompletion,
  type LLMStreamRequestEvent,
  type PromptAssembly,
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

  it('includes session history in later followup requests', async () => {
    const root = await mountRoot()
    const requests: string[][] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        requests.push(messages.map(message => message.content))
        return { content: 'answer', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('history-followup.jsonl'), llm)
    handle.agent.followup({ text: 'first' })
    await handle.agent.whenIdle()
    handle.agent.followup({ text: 'second' })
    await handle.agent.whenIdle()

    expect(requests).toEqual([
      ['first'],
      ['first', 'answer', 'second'],
    ])
    await handle.dispose()
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

  it('claims steering and followup inputs in one step batch', async () => {
    const root = await mountRoot()
    const calls: string[][] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        calls.push(messages.map(message => message.content))
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('steer.jsonl'), llm)
    handle.agent.followup({ text: 'queued' })
    handle.agent.steer({ text: 'urgent' })

    await handle.agent.whenIdle()
    expect(calls).toEqual([['urgent', 'queued']])
  })

  it('opens one turn for idle steer while idle inject remains inert', async () => {
    const root = await mountRoot()
    const requests: string[][] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        requests.push(messages.map(message => message.content))
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('idle-steer.jsonl'), llm)

    handle.agent.steer({ text: 'steer now' })
    await handle.agent.whenIdle()

    await handle.dispose()
    expect(requests).toEqual([['steer now']])
  })

  it.each(['afterRun', 'idle status'] as const)(
    'runs steer submitted during %s cleanup as a later turn',
    async boundary => {
      const root = await mountRoot()
      const requests: string[] = []
      const llm: LLMAdapter = {
        async complete(messages) {
          requests.push(messages.at(-1)!.content)
          return { content: 'done', finishReason: 'stop' }
        },
      }
      let steered = false
      const sendLateSteer = (): void => {
        if (steered) return
        steered = true
        handle.agent.steer({ text: 'during cleanup' })
      }
      const registry = dynamic(root).agents as AgentRegistry
      const handle = await registry.create({
        id: 'cleanup-steer', file: await tempFile(`cleanup-steer-${boundary}.jsonl`), llm,
        hooks: {
          afterRun: async () => {
            if (boundary !== 'afterRun' || steered) return
            sendLateSteer()
            await waitForPending(handle.agent, 'during cleanup')
          },
        },
      })
      root.on('agent/status', (payload: { id: string; status: string }) => {
        if (boundary === 'idle status' && payload.id === handle.agent.id && payload.status === 'idle') {
          sendLateSteer()
        }
      })

      try {
        handle.agent.followup({ text: 'first' })
        await expect.poll(() => requests).toEqual(['first', 'during cleanup'])
        await handle.agent.whenIdle()
        expect(handle.agent.inbox.size).toBe(0)
        expect((await handle.agent.session.read())
          .filter(event => event.type === 'turn/start')).toHaveLength(2)
      } finally {
        await handle.dispose()
      }
    },
  )

  it('durably stages inject input without waking until a followup arrives', async () => {
    const root = await mountRoot()
    const calls: string[][] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        calls.push(messages.map(message => message.content))
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('inject-idle.jsonl'), llm)

    handle.agent.inject({ text: 'injected context' })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(handle.agent.status).toBe('idle')
    expect(calls).toEqual([])
    expect(handle.agent.inbox.snapshot().nextStep.map(message => message.text))
      .toEqual(['injected context'])

    handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()

    expect(calls).toEqual([['injected context', 'go']])
    await handle.dispose()
  })

  it('keeps an inject idle after cancellation clears a wake reservation', async () => {
    const root = await mountRoot()
    const calls: string[] = []
    const handle = await createHandle(root, await tempFile('cancel-clears-wake.jsonl'), {
      async complete(messages) {
        calls.push(messages.at(-1)?.content ?? '')
        return { content: 'done', finishReason: 'stop' }
      },
    })

    handle.agent.steer({ text: 'discarded steer' })
    handle.agent.cancel({ type: 'user' })
    await handle.agent.whenIdle()
    handle.agent.inject({ text: 'staged context' })

    const settled = await Promise.race([
      handle.agent.whenIdle().then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
    ])
    const staged = handle.agent.inbox.snapshot().nextStep.map(message => message.text)
    await handle.dispose()

    expect(settled).toBe(true)
    expect(calls).toEqual([])
    expect(staged).toEqual(['staged context'])
  })

  it('settles whenIdle while only injected next-step input is staged', async () => {
    const root = await mountRoot()
    const handle = await createHandle(root, await tempFile('inject-idle-settle.jsonl'))

    handle.agent.inject({ text: 'staged only' })
    const idle = handle.agent.whenIdle().then(() => true)
    try {
      await expect(Promise.race([
        idle,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ])).resolves.toBe(true)
    } finally {
      await handle.dispose()
      await idle
    }
  })

  it('keeps steering submitted from turn-stopping in the same turn', async () => {
    const root = await mountRoot()
    const calls: string[][] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        calls.push(messages.map(message => message.content))
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('turn-stopping-steer.jsonl'), llm)
    let steered = false
    root.on('agent/turn-stopping', () => {
      if (!steered) {
        steered = true
        handle.agent.steer({ text: 'one more thing' })
      }
    })

    handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()

    expect(calls).toEqual([['go'], ['go', 'done', 'one more thing']])
    const turns = (await handle.agent.session.read())
      .filter(event => event.type === 'turn/start')
    expect(turns).toHaveLength(1)
    await handle.dispose()
  })

  it('consumes an in-turn steer reservation before cleanup stages inert inject input', async () => {
    const root = await mountRoot()
    const calls: string[] = []
    const registry = dynamic(root).agents as AgentRegistry
    const handle = await registry.create({
      id: 'consumed-steer', file: await tempFile('consumed-steer.jsonl'),
      llm: {
        async complete(messages) {
          calls.push(messages.at(-1)!.content)
          return { content: 'done', finishReason: 'stop' }
        },
      },
      hooks: {
        afterRun: async () => {
          handle.agent.inject({ text: 'staged only' })
          await waitForPending(handle.agent, 'staged only')
        },
      },
    })
    let steered = false
    root.on('agent/turn-stopping', () => {
      if (steered) return
      steered = true
      handle.agent.steer({ text: 'in-turn steer' })
    })

    handle.agent.followup({ text: 'first' })
    const idle = handle.agent.whenIdle().then(() => true)
    try {
      await expect(Promise.race([
        idle,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
      ])).resolves.toBe(true)
      expect(calls).toEqual(['first', 'in-turn steer'])
      expect(handle.agent.inbox.snapshot().nextStep.map(message => message.text)).toEqual(['staged only'])
      expect((await handle.agent.session.read()).filter(event => event.type === 'turn/start')).toHaveLength(1)
    } finally {
      await handle.dispose()
      await idle
    }
  })

  it('admits tool-time inject input after the tool result in the same turn', async () => {
    const root = await mountRoot()
    const requests: string[][] = []
    let calls = 0
    const llm: LLMAdapter = {
      async complete(messages) {
        requests.push(messages.map(message => message.content))
        calls += 1
        return calls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'notice', name: 'notice_tool', arguments: {} }],
              finishReason: 'tool_calls',
            }
          : { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('tool-inject.jsonl'), llm)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'notice_tool', description: 'injects a notice' },
      execute: () => {
        handle.agent.inject({ text: 'tool-time context' })
        handle.agent.inject({ messages: [{ role: 'system', content: 'tool-time system' }] })
        return 'tool result'
      },
    })

    handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()

    expect(requests).toEqual([
      ['go'],
      ['go', '', 'tool result', 'tool-time context', 'tool-time system'],
    ])
    const events = await handle.agent.session.read()
    const resultIndex = events.findIndex(event => event.type === 'tool/result')
    const contextIndex = events.findIndex(event => event.type === 'user/message'
      && event.payload.content === 'tool-time context')
    const systemIndex = events.findIndex(event => event.type === 'system/message'
      && event.payload.content === 'tool-time system')
    expect(contextIndex).toBeGreaterThan(resultIndex)
    expect(systemIndex).toBeGreaterThan(resultIndex)
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    await handle.dispose()
  })

  it('keeps injected input pending when a tool concludes the turn', async () => {
    const root = await mountRoot()
    let calls = 0
    const llm: LLMAdapter = {
      async complete() {
        calls += 1
        return calls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'finish', name: 'finish_tool', arguments: {} }],
              finishReason: 'tool_calls',
            }
          : { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('concluding-tool-inject.jsonl'), llm)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'finish_tool', description: 'concludes after injecting' },
      metadata: { concludesTurn: true },
      execute: () => {
        handle.agent.inject({ text: 'preserve this' })
        return 'finished'
      },
    })

    handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()
    expect(handle.agent.inbox.snapshot().nextStep.map(message => message.text))
      .toEqual(['preserve this'])

    handle.agent.followup({ text: 'continue' })
    await handle.agent.whenIdle()
    expect(calls).toBe(2)
    await handle.dispose()
  })

  it('keeps a followup received during a request for a later turn', async () => {
    const root = await mountRoot()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const requests: string[][] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        requests.push(messages.map(message => message.content))
        if (requests.length === 1) await gate
        return { content: `answer ${requests.length}`, finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('running-followup.jsonl'), llm)
    handle.agent.followup({ text: 'first' })
    await new Promise<void>(resolve => {
      root.on('agent/status', (event: { id: string; status: string }) => {
        if (event.id === handle.agent.id && event.status === 'running') resolve()
      })
    })
    handle.agent.followup({ text: 'second' })
    release()
    await handle.agent.whenIdle()

    expect(requests).toEqual([
      ['first'],
      ['first', 'answer 1', 'second'],
    ])
    expect((await handle.agent.session.read()).filter(event => event.type === 'turn/start'))
      .toHaveLength(2)
    await handle.dispose()
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

  it('runs steer submitted after abort as a later turn', async () => {
    const root = await mountRoot()
    const requests: string[][] = []
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const llm: LLMAdapter = {
      async complete(messages, _tools, options) {
        requests.push(messages.map(message => message.content))
        if (requests.length === 1) {
          began()
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            })
          })
        }
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('post-abort-steer.jsonl'), llm)
    const running = new Promise<void>(resolve => {
      root.on('agent/status', (event: { id: string; status: string }) => {
        if (event.id === handle.agent.id && event.status === 'running') resolve()
      })
    })

    handle.agent.followup({ text: 'active' })
    await running
    await started
    handle.agent.cancel({ type: 'user' }, { keepInbox: true })
    handle.agent.steer({ text: 'after abort' })
    await handle.agent.whenIdle()

    const turns = (await handle.agent.session.read())
      .filter(event => event.type === 'turn/start')
      .map(event => event.payload.turn)
    await handle.dispose()
    expect(requests).toContainEqual(expect.arrayContaining(['after abort']))
    expect(turns).toEqual([1, 2])
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

  it('cancels an active maintenance task', async () => {
    const root = await mountRoot()
    const handle = await createHandle(root, await tempFile('maintenance-cancel.jsonl'))
    let sawSignal: AbortSignal | undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const task = handle.agent.runMaintenance(async (signal) => {
      sawSignal = signal
      await gate
      if (signal.aborted) throw new Error('maintenance cancelled')
      return 'done'
    })
    handle.agent.cancel({ type: 'user' })
    release()
    await expect(task).rejects.toThrow('maintenance cancelled')
    expect(sawSignal?.aborted).toBe(true)
    await handle.dispose()
  })

  it('holds followups until maintenance settles', async () => {
    const root = await mountRoot()
    const calls: string[] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        calls.push(messages.at(-1)?.content ?? '')
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const handle = await createHandle(root, await tempFile('maintenance-wait.jsonl'), llm)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const maintenance = handle.agent.runMaintenance(async () => {
      await gate
    })

    handle.agent.followup({ text: 'after maintenance' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toEqual([])

    release()
    await maintenance
    await handle.agent.whenIdle()
    expect(calls).toEqual(['after maintenance'])
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

  it('uses setup-scoped LLM middleware without affecting another live agent', async () => {
    const root = await mountRoot()
    let rootCalls = 0
    let scopedCalls = 0
    let scopedMiddlewareCalls = 0
    const rootLlm: LLMAdapter = {
      async complete() {
        rootCalls += 1
        return { content: 'root', finishReason: 'stop' }
      },
    }
    const scopedLlm: LLMAdapter = {
      async complete(_messages, _tools, options) {
        scopedCalls += 1
        expect(options.provider).toBe('scoped')
        return { content: 'scoped', finishReason: 'stop' }
      },
    }
    const rootLlmService = new LlmService()
    rootLlmService.register('root', rootLlm)
    root.provide('llm', rootLlmService)
    const scopedLlmService = new LlmService()
    scopedLlmService.register('scoped', scopedLlm)
    const registry = dynamic(root).agents as AgentRegistry
    const scoped = await registry.create({
      id: 'scoped-runtime-agent',
      file: await tempFile('scoped-runtime.jsonl'),
      setup: (agentCtx) => {
        agentCtx.provide('llm', scopedLlmService)
        agentCtx.on('llm/stream', async (payload, next) => {
          scopedMiddlewareCalls += 1
          payload.options = { ...payload.options, provider: 'scoped' }
          return next()
        })
      },
    })
    const sibling = await registry.create({
      id: 'root-runtime-agent',
      file: await tempFile('root-runtime.jsonl'),
    })

    scoped.agent.followup({ text: 'scoped' })
    sibling.agent.followup({ text: 'root' })
    await Promise.all([scoped.agent.whenIdle(), sibling.agent.whenIdle()])

    expect(scopedCalls).toBe(1)
    expect(scopedMiddlewareCalls).toBe(1)
    expect(rootCalls).toBe(1)
    await Promise.all([scoped.dispose(), sibling.dispose()])
  })

  it('inherits root system prompt defaults while setup overrides remain local', async () => {
    const root = await mountRoot()
    const requests: string[][] = []
    const llm: LLMAdapter = {
      async complete(messages) {
        requests.push(messages.map(message => message.content))
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const rootPrompt = new SystemPromptService()
    rootPrompt.registerSection({ name: 'system', content: 'root instructions' })
    root.provide('systemPrompt', rootPrompt)
    const scopedPrompt = new SystemPromptService()
    scopedPrompt.registerSection({ name: 'system', content: 'scoped instructions' })
    const scoped = await createHandle(root, await tempFile('scoped-prompt.jsonl'), llm,
      undefined, agentCtx => { agentCtx.provide('systemPrompt', scopedPrompt) })
    const sibling = await createHandle(root, await tempFile('root-prompt.jsonl'), llm)

    scoped.agent.followup({ text: 'scoped' })
    await scoped.agent.whenIdle()
    sibling.agent.followup({ text: 'root' })
    await sibling.agent.whenIdle()

    expect(requests).toEqual([
      ['scoped instructions', 'scoped'],
      ['root instructions', 'root'],
    ])
    await Promise.all([scoped.dispose(), sibling.dispose()])
  })

  it('keeps setup lifecycle and inbox listeners scoped while root observes both agents', async () => {
    const root = await mountRoot()
    const rootStatuses: string[] = []
    const rootInbox: string[] = []
    const scopedEvents: string[] = []
    root.on('agent/status', (payload: { id: string; status: string }) => {
      rootStatuses.push(`${payload.id}:${payload.status}`)
    })
    root.on('agent/inbox/inserted', (payload: { id: string }) => {
      rootInbox.push(payload.id)
    })
    const registry = dynamic(root).agents as AgentRegistry
    const watcher = await registry.create({
      id: 'scoped-event-watcher',
      file: await tempFile('scoped-event-watcher.jsonl'),
      llm: fakeLLM([{ content: 'watcher', finishReason: 'stop' }]),
      setup: (agentCtx) => {
        agentCtx.on('agent/status', (payload: { id: string; status: string }) => {
          scopedEvents.push(`status:${payload.id}:${payload.status}`)
        })
        agentCtx.on('agent/inbox/inserted', (payload: { id: string }) => {
          scopedEvents.push(`inserted:${payload.id}`)
        })
        agentCtx.on('agent/inbox/claimed', (payload: { id: string }) => {
          scopedEvents.push(`claimed:${payload.id}`)
        })
      },
    })
    const runner = await registry.create({
      id: 'scoped-event-runner',
      file: await tempFile('scoped-event-runner.jsonl'),
      llm: fakeLLM([{ content: 'runner', finishReason: 'stop' }]),
    })

    runner.agent.followup({ text: 'run' })
    await runner.agent.whenIdle()

    expect(scopedEvents).toEqual([])
    expect(rootInbox).toEqual(['scoped-event-runner'])
    expect(rootStatuses).toEqual([
      'scoped-event-runner:running',
      'scoped-event-runner:idle',
    ])
    await Promise.all([watcher.dispose(), runner.dispose()])
  })

  it('composes shared and nested setup plugin middleware without sibling leakage', async () => {
    const root = await mountRoot()
    const rootPrompt = new SystemPromptService(root)
    rootPrompt.registerSection({ name: 'system', content: 'base' })
    root.provide('systemPrompt', rootPrompt)
    const requests: Array<{ provider: string | undefined; model: string | undefined; system: string }> = []
    const scopedStatuses: string[] = []
    const sharedStatuses: string[] = []
    const llm: LLMAdapter = {
      async complete(messages, _tools, options) {
        requests.push({ provider: options.provider, model: options.model, system: messages[0]!.content })
        return { content: 'done', finishReason: 'stop' }
      },
    }
    await root.plugin(async sharedCtx => {
      await sharedCtx.plugin(pluginCtx => {
        pluginCtx.on('llm/stream', (payload: LLMStreamRequestEvent, next) => {
          payload.options.provider = 'shared'
          return next()
        })
        pluginCtx.on('system-prompt/assemble', (payload: PromptAssembly, next) => {
          payload.text += ' shared'
          return next()
        })
        pluginCtx.on('agent/status', (payload: { id: string; status: string }) => {
          sharedStatuses.push(`${payload.id}:${payload.status}`)
        })
      })
    })
    const registry = dynamic(root).agents as AgentRegistry
    const scoped = await registry.create({
      id: 'plugin-scoped',
      file: await tempFile('plugin-scoped.jsonl'),
      llm,
      setup: async agentCtx => {
        await agentCtx.plugin(async setupCtx => {
          await setupCtx.plugin(pluginCtx => {
            pluginCtx.on('llm/stream', (payload: LLMStreamRequestEvent, next) => {
              payload.options.model = 'scoped'
              return next()
            })
            pluginCtx.on('system-prompt/assemble', (payload: PromptAssembly, next) => {
              payload.text += ' scoped'
              return next()
            })
            pluginCtx.on('agent/status', (payload: { id: string; status: string }) => {
              scopedStatuses.push(`${payload.id}:${payload.status}`)
            })
          })
        })
      },
    })
    const sibling = await registry.create({
      id: 'plugin-sibling', file: await tempFile('plugin-sibling.jsonl'), llm,
    })

    scoped.agent.followup({ text: 'scoped' })
    await scoped.agent.whenIdle()
    sibling.agent.followup({ text: 'sibling' })
    await sibling.agent.whenIdle()

    expect(requests).toEqual([
      { provider: 'shared', model: 'scoped', system: 'base shared scoped' },
      { provider: 'shared', model: undefined, system: 'base shared' },
    ])
    expect(scopedStatuses).toEqual(['plugin-scoped:running', 'plugin-scoped:idle'])
    expect(sharedStatuses).toEqual([
      'plugin-scoped:running', 'plugin-scoped:idle',
      'plugin-sibling:running', 'plugin-sibling:idle',
    ])
    await Promise.all([scoped.dispose(), sibling.dispose()])
  })

  it('uses tools registered by setup only for that live agent', async () => {
    const root = await mountRoot()
    let toolExecutions = 0
    let requests = 0
    const llm: LLMAdapter = {
      async complete() {
        requests += 1
        return requests === 1
          ? {
              toolCalls: [{ id: 'scoped-tool-call', name: 'scoped_tool', arguments: {} }],
              finishReason: 'tool_calls',
            }
          : { content: 'done', finishReason: 'stop' }
      },
    }
    const registry = dynamic(root).agents as AgentRegistry
    const handle = await registry.create({
      id: 'scoped-tools-agent',
      file: await tempFile('scoped-tools.jsonl'),
      llm,
      setup: (agentCtx) => {
        const scopedTools = new ToolsService(agentCtx)
        scopedTools.register({
          schema: { name: 'scoped_tool', description: 'runs in the agent scope' },
          execute: () => {
            toolExecutions += 1
            return { content: 'scoped result' }
          },
        })
      },
    })

    handle.agent.followup({ text: 'use scoped tool' })
    await handle.agent.whenIdle()

    expect(toolExecutions).toBe(1)
    await handle.dispose()
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

  it('restores structured pending content on resume', async () => {
    const file = await tempFile('resume-structured.jsonl')
    const prior = new SessionLog(file)
    await prior.init()
    await prior.append('meta', {
      kind: 'agent',
      agentId: 'resume-structured',
    })
    const priorInbox = new DurableInbox(prior)
    const structured = [
      { role: 'system' as const, content: 'system context' },
      { role: 'user' as const, content: 'user context' },
    ]
    await priorInbox.insert({
      text: 'plain prompt',
      content: structured,
    })
    await prior.flush()
    await prior.close()

    const root = await mountRoot()
    let seen: ModelMessage[] | undefined
    const llm: LLMAdapter = {
      async complete(messages) {
        seen = [...messages]
        return { content: 'done', finishReason: 'stop' }
      },
    }
    const registry = dynamic(root).agents as AgentRegistry
    const resumed = await registry.resume({
      id: 'resume-structured',
      file,
      llm,
    })
    await resumed.agent.whenIdle()
    expect(seen?.filter(message => message.role !== 'system')
      .map(message => message.content)).toEqual(['user context'])
    await resumed.dispose()
  })

  it('does not wake an inject-only inbox after resume', async () => {
    const file = await tempFile('resume-inject-only.jsonl')
    const prior = new SessionLog(file)
    await prior.init()
    await prior.append('meta', { kind: 'agent', agentId: 'resume-inject-only' })
    const priorInbox = new DurableInbox(prior)
    await priorInbox.insert({ text: 'staged context' }, 'next-step')
    await prior.flush()
    await prior.close()

    const root = await mountRoot()
    const calls: string[] = []
    const registry = dynamic(root).agents as AgentRegistry
    const resumed = await registry.resume({
      id: 'resume-inject-only',
      file,
      llm: {
        async complete(messages) {
          calls.push(messages.at(-1)?.content ?? '')
          return { content: 'done', finishReason: 'stop' }
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toEqual([])
    expect(resumed.agent.inbox.snapshot().nextStep.map(message => message.text))
      .toEqual(['staged context'])
    await resumed.dispose()
  })

  it('wakes an idle steer restored from the durable inbox', async () => {
    const file = await tempFile('resume-idle-steer.jsonl')
    const prior = new SessionLog(file)
    await prior.init()
    await prior.append('meta', { kind: 'agent', agentId: 'resume-idle-steer' })
    const priorInbox = new DurableInbox(prior)
    await priorInbox.steer({ text: 'restored steer' })
    await prior.flush()
    await prior.close()

    const root = await mountRoot()
    const calls: string[] = []
    const registry = dynamic(root).agents as AgentRegistry
    const resumed = await registry.resume({
      id: 'resume-idle-steer',
      file,
      llm: {
        async complete(messages) {
          calls.push(messages.at(-1)?.content ?? '')
          return { content: 'done', finishReason: 'stop' }
        },
      },
    })

    await resumed.agent.whenIdle()
    await resumed.dispose()
    expect(calls).toEqual(['restored steer'])
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

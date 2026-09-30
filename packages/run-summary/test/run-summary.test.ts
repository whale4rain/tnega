import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentService, type AgentRunCompletedEvent } from '@tnega/agent'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { tools } from '@tnega/tools'
import { runSummary } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-run-summary-'))
  directories.push(directory)
  const session = new SessionLog(join(directory, 'session.jsonl'))
  await session.init()
  const root = new Context()
  await root.plugin(tools)
  return { root, session }
}

it('awaits summary persistence before run/end and reloads without changing model history', async () => {
  const { root, session } = await setup()
  try {
    await root.plugin(runSummary)
    let historyBefore: unknown
    root.on('agent/run-completed', async (event: AgentRunCompletedEvent) => {
      historyBefore = await event.session.deriveMessages()
      expect((await event.session.read()).at(-1)?.type).toBe('meta')
    })
    let calls = 0
    const service = new AgentService(root, {
      session,
      llm: { async complete() {
        calls += 1
        return calls === 1
          ? { content: 'Checking.', toolCalls: [{ id: 'c1', name: 'missing', arguments: {} }], finishReason: 'tool_calls' }
          : { content: 'Done.', finishReason: 'stop' }
      } },
    })
    for await (const event of service.runStream({ text: 'Work' })) {
      if (event.type === 'run/end') expect((await session.read()).at(-1)?.payload).toMatchObject({ kind: 'run/summary', turn: 1, summary: 'Done.' })
    }
    expect(await session.deriveMessages()).toEqual(historyBefore)
    const events = await session.read()
    const final = events.findLast(event => event.type === 'assistant/message')
    expect(events.at(-1)?.payload).toMatchObject({ sourceMessageId: final?.id })
    await session.close()
    const reopened = new SessionLog(session.file)
    await reopened.init()
    expect((await reopened.read()).at(-1)?.payload).toMatchObject({ kind: 'run/summary', summary: 'Done.' })
    await reopened.close()
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})

it('does not summarize unsuccessful runs, interrupted answers or a disposed plugin', async () => {
  const { root, session } = await setup()
  try {
    const fiber = await root.plugin(runSummary)
    await session.append('turn/start', { turn: 3 })
    await session.append('assistant/message', { content: 'Partial', interrupted: true })
    await session.append('turn/end', { turn: 3, finishReason: 'cancelled' })
    const result = { input: {}, output: 'Partial', turn: 3, steps: [], messages: [], finishReason: 'stop' } satisfies AgentRunCompletedEvent['result']
    for (const finishReason of ['cancelled', 'error', 'max_steps', 'max_turns', 'length'] as const) {
      await root.parallel('agent/run-completed', { session, result: { ...result, finishReason } })
    }
    await root.parallel('agent/run-completed', { session, result })
    const cancelled = new AbortController()
    cancelled.abort()
    await root.parallel('agent/run-completed', { session, result, signal: cancelled.signal })
    await fiber.dispose()
    await session.append('turn/start', { turn: 4 })
    await session.append('assistant/message', { content: 'Done' })
    await session.append('turn/end', { turn: 4, finishReason: 'stop' })
    await root.parallel('agent/run-completed', { session, result: { ...result, turn: 4 } })
    expect((await session.read()).some(event => event.type === 'meta' && event.payload.kind === 'run/summary')).toBe(false)
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})

it('uses only the last assistant message within its completed durable turn', async () => {
  const { root, session } = await setup()
  try {
    await root.plugin(runSummary)
    const result = { input: {}, output: '', steps: [], messages: [], finishReason: 'stop' } satisfies AgentRunCompletedEvent['result']
    await session.append('turn/start', { turn: 1 })
    await session.append('assistant/message', { content: 'Old answer' })
    await session.append('turn/end', { turn: 1, finishReason: 'stop' })
    for (const [index, payload] of [
      { content: '' },
      { content: 'Incomplete', interrupted: true },
      { content: 'Calling', toolCalls: [{ id: 'c', name: 'missing', arguments: {} }] },
    ].entries()) {
      const turn = index + 2
      await session.append('turn/start', { turn })
      await session.append('assistant/message', { content: 'Earlier interim answer' })
      await session.append('assistant/message', payload)
      await session.append('turn/end', { turn, finishReason: 'stop' })
      await root.parallel('agent/run-completed', { session, result: { ...result, turn } })
    }
    expect((await session.read()).some(event => event.type === 'meta' && event.payload.kind === 'run/summary')).toBe(false)
    const cancelled = new AbortController()
    cancelled.abort()
    await root.parallel('agent/run-completed', { session, result: { ...result, turn: 1 }, signal: cancelled.signal })
    expect((await session.read()).some(event => event.type === 'meta' && event.payload.kind === 'run/summary')).toBe(false)
    await root.parallel('agent/run-completed', { session, result: { ...result, turn: 1 } })
    await root.parallel('agent/run-completed', { session, result: { ...result, turn: 1 } })
    expect((await session.read()).filter(event => event.type === 'meta' && event.payload.kind === 'run/summary')).toHaveLength(1)
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})


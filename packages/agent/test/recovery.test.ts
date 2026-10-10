import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog, type ModelMessage } from '@tnega/session'
import { tools } from '@tnega/tools'
import {
  agents,
  findInterruptedTurn,
  RECOVERY_NUDGE_NAME,
  recoverInterruptedTurn,
  type AgentRegistry,
  type LLMAdapter,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-recovery-'))
  dirs.push(dir)
  return join(dir, name)
}

/** A Session whose process died while one tool call of its turn was running. */
async function crashedLog(
  file: string,
  call: { name: string; interruption: 'fail' | 'retry' | 'confirm' },
): Promise<void> {
  const log = new SessionLog(file)
  await log.init()
  await log.append('meta', { kind: 'agent', agentId: 'agent-1', createdAt: 1 })
  await log.append('turn/start', { turn: 1, input: 'fix it', reason: 'user' })
  await log.append('step/start', { turn: 1, step: 0 })
  await log.append('user/message', { content: 'fix it' })
  await log.append('assistant/message', { content: '', toolCalls: [{ id: 'c1', name: call.name, arguments: {} }] })
  await log.append('tool/call', { id: 'c1', name: call.name, arguments: {}, interruption: call.interruption })
  // The process died here, before the result or turn end. Closing only
  // releases this process's ownership; it writes no closing events.
  await log.close()
}

async function resume(file: string, llm: LLMAdapter) {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  const registry = (root as unknown as { agents: AgentRegistry }).agents
  return registry.resume({ id: 'agent-1', file, llm, autoRecover: true })
}

function recording(): { llm: LLMAdapter; requests: (readonly ModelMessage[])[] } {
  const requests: (readonly ModelMessage[])[] = []
  return {
    requests,
    llm: { async complete(messages) {
      requests.push(messages)
      return { content: 'done', finishReason: 'stop' }
    } },
  }
}

it('continues a crashed turn whose cut-off call is safe to repeat', async () => {
  const file = await tempFile('safe.jsonl')
  await crashedLog(file, { name: 'read_file', interruption: 'retry' })
  const { llm, requests } = recording()

  const handle = await resume(file, llm)
  await handle.agent.whenIdle()

  expect(requests).toHaveLength(1)
  const last = requests[0]!.at(-1)
  expect(last).toMatchObject({ role: 'user', name: RECOVERY_NUDGE_NAME })
  // The model sees the interrupted result before the recovery input.
  expect(requests[0]!.some(message => message.role === 'tool' && message.tool_call_id === 'c1')).toBe(true)
  expect(findInterruptedTurn(await handle.agent.session.read())).toBeUndefined()
  await handle.dispose()

  // Reopening a recovered Session does not recover it again.
  const again = recording()
  const reopened = await resume(file, again.llm)
  await reopened.agent.whenIdle()
  expect(again.requests).toHaveLength(0)
  await reopened.dispose()
})

it('waits for the user when a cut-off call may already have taken effect', async () => {
  const file = await tempFile('uncertain.jsonl')
  await crashedLog(file, { name: 'shell', interruption: 'confirm' })
  const { llm, requests } = recording()

  const handle = await resume(file, llm)
  await handle.agent.whenIdle()
  expect(requests).toHaveLength(0)
  expect(findInterruptedTurn(await handle.agent.session.read())).toMatchObject({ safe: false, uncertainCalls: ['shell'] })

  // An explicit Resume continues it.
  expect(await recoverInterruptedTurn(handle.agent)).toBe(true)
  await handle.agent.whenIdle()
  expect(requests).toHaveLength(1)
  expect(await recoverInterruptedTurn(handle.agent)).toBe(false)
  await handle.dispose()
})

it('does not recover a recovery turn that crashed again', async () => {
  const file = await tempFile('loop.jsonl')
  const log = new SessionLog(file)
  await log.init()
  await log.append('meta', { kind: 'agent', agentId: 'agent-1', createdAt: 1 })
  await log.append('turn/start', { turn: 1, input: '', reason: 'user' })
  await log.append('step/start', { turn: 1, step: 0 })
  await log.append('user/message', { content: 'continue', name: RECOVERY_NUDGE_NAME })
  await log.close()

  const { llm, requests } = recording()
  const handle = await resume(file, llm)
  await handle.agent.whenIdle()
  expect(requests).toHaveLength(0)
  expect(findInterruptedTurn(await handle.agent.session.read())).toMatchObject({ safe: false })
  await handle.dispose()
})

it('leaves cancelled and failed turns alone', () => {
  const base = [
    { id: 's', seq: 1, ts: 1, type: 'turn/start' as const, payload: { turn: 1 } },
  ]
  expect(findInterruptedTurn([...base, { id: 'e', seq: 2, ts: 2, type: 'turn/end', payload: { turn: 1, finishReason: 'cancelled', cancelCause: { type: 'user' } } }])).toBeUndefined()
  expect(findInterruptedTurn([...base, { id: 'e', seq: 2, ts: 2, type: 'turn/end', payload: { turn: 1, finishReason: 'error', interrupted: true, error: { name: 'Error', message: 'boom' } } }])).toBeUndefined()
  expect(findInterruptedTurn([...base, { id: 'e', seq: 2, ts: 2, type: 'turn/end', payload: { turn: 1, finishReason: 'interrupted', interrupted: true } }])).toMatchObject({ turn: 1, safe: true })
})

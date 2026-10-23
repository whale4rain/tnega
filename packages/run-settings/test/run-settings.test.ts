import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { agents, type AgentRegistry, type CompleteOptions, type LLMAdapter, type LLMStreamEvent } from '@tnega/agent'
import { SessionLog, deriveSurfaceMessages, type ModelMessage, type SessionEvent, type SessionPermission } from '@tnega/session'
import {
  PERMISSION_NOTICE_NAME,
  pendingPermission,
  routedAdapter,
  runSettings,
  type ModelSelection,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const notice = (level: SessionPermission): string => `Session permission changed: ${level}.`

interface Seen { messages: readonly ModelMessage[]; options: CompleteOptions }

/**
 * One turn of two steps. The first step's tool plays the user changing the
 * settings while the turn runs: it writes the permission change to the live
 * Session and switches the selection, exactly as the host's PATCH does.
 */
async function runWithMidTurnChange() {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-run-settings-'))
  dirs.push(dir)
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  const registry = root.get('agents') as AgentRegistry
  let selection: ModelSelection = { route: 'fast', model: 'fast-model', reasoningEffort: 'low' }
  await root.plugin(runSettings, {
    session: (agentId: string | undefined) => agentId === 'main' ? registry.get(agentId)?.session : undefined,
    selection: async () => selection,
    permissionNotice: notice,
  })
  root.get('tools').register({
    schema: { name: 'work', description: 'work', parameters: { type: 'object', properties: {} } },
    execute: async () => {
      await registry.get('main')?.session.append('permission/mode', { mode: 'workspace-write' })
      selection = { route: 'deep', model: 'deep-model', reasoningEffort: 'high' }
      return 'done'
    },
  })
  const seen: Seen[] = []
  const llm: LLMAdapter = {
    async complete(messages, _tools, options) {
      seen.push({ messages: [...messages], options: { ...options } })
      return seen.length === 1
        ? { content: '', toolCalls: [{ id: 'call-1', name: 'work', arguments: {} }], finishReason: 'tool_calls' }
        : { content: 'finished', finishReason: 'stop' }
    },
  }
  const file = join(dir, 'session.jsonl')
  const handle = await registry.create({ id: 'main', file, llm })
  await handle.agent.followup({ text: 'go' })
  await handle.agent.whenIdle()
  const events = await handle.agent.session.read()
  await handle.dispose()
  return { seen, events, file }
}

describe('runSettings', () => {
  it('applies a mid-turn model and effort change from the next step', async () => {
    const { seen, events } = await runWithMidTurnChange()
    expect(seen).toHaveLength(2)
    expect(seen[0]!.options).toMatchObject({ provider: 'fast', model: 'fast-model', reasoningEffort: 'low' })
    expect(seen[1]!.options).toMatchObject({ provider: 'deep', model: 'deep-model', reasoningEffort: 'high' })

    // The switch is durable: the second step's request header records it.
    const headers = events.flatMap(event => event.type === 'request/header' ? [event.payload] : [])
    expect(headers.map(header => header.reason)).toEqual(['initial', 'change'])
    expect(headers[1]!.config).toMatchObject({ provider: 'deep', model: 'deep-model', reasoningEffort: 'high' })
    const end = events.find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.payload.finishReason).toBe('stop')
  })

  it('tells the model about a mid-turn permission change at the next step, once', async () => {
    const { seen, events, file } = await runWithMidTurnChange()
    const notices = (messages: readonly ModelMessage[]) => messages.filter(message => message.name === PERMISSION_NOTICE_NAME)
    expect(notices(seen[0]!.messages)).toEqual([])
    expect(notices(seen[1]!.messages).map(message => message.content)).toEqual([notice('workspace-write')])

    // The live request and the replayed Session agree: the notice is history.
    expect(notices(deriveSurfaceMessages(events))).toHaveLength(1)
    expect(pendingPermission(events)).toBeUndefined()
    const log = new SessionLog(file)
    await log.init()
    try {
      expect(notices(await log.deriveMessages())).toHaveLength(1)
    } finally {
      await log.close()
    }
  })

  it('leaves other agents alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-run-settings-'))
    dirs.push(dir)
    const root = new Context()
    await root.plugin(tools)
    await root.plugin(agents)
    await root.plugin(runSettings, {
      session: () => undefined,
      selection: async () => ({ route: 'deep', model: 'deep-model' }),
      permissionNotice: notice,
    })
    const seen: CompleteOptions[] = []
    const llm: LLMAdapter = {
      async complete(_messages, _tools, options) {
        seen.push({ ...options })
        return { content: 'ok', finishReason: 'stop' }
      },
    }
    const handle = await (root.get('agents') as AgentRegistry).create({ id: 'sub', file: join(dir, 's.jsonl'), llm })
    await handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()
    await handle.dispose()
    expect(seen[0]!.provider).toBeUndefined()
  })
})

describe('pendingPermission', () => {
  const level = (seq: number, mode: SessionPermission): SessionEvent =>
    ({ id: String(seq), seq, ts: seq, type: 'permission/mode', payload: { mode } })
  const system = (seq: number, content: string, name?: string): SessionEvent =>
    ({ id: String(seq), seq, ts: seq, type: 'system/message', payload: { content, ...(name ? { name } : {}) } })

  it('is due once after each change, and counts notices written before they had a name', () => {
    expect(pendingPermission([])).toBeUndefined()
    expect(pendingPermission([level(1, 'bypass')])).toBe('bypass')
    expect(pendingPermission([level(1, 'bypass'), system(2, 'Session permission changed: full access.')])).toBeUndefined()
    expect(pendingPermission([level(1, 'bypass'), system(2, 'x', PERMISSION_NOTICE_NAME), level(3, 'read-only')])).toBe('read-only')
    // Back to the level the model already knows: nothing to say.
    expect(pendingPermission([level(1, 'bypass'), system(2, 'x', PERMISSION_NOTICE_NAME), level(3, 'bypass')])).toBeUndefined()
  })
})

describe('routedAdapter', () => {
  const reply = (label: string): LLMAdapter => ({
    async complete() { return { content: label, finishReason: 'stop' } },
  })

  it('sends a call to the route its options name, and the rest to the fallback', async () => {
    const asked: ModelSelection[] = []
    const adapter = routedAdapter(selection => {
      asked.push(selection)
      return reply(selection.route)
    }, reply('fallback'))
    expect((await adapter.complete([], [], {})).content).toBe('fallback')
    expect((await adapter.complete([], [], { provider: 'deep', model: 'deep-model', reasoningEffort: 'high' })).content).toBe('deep')
    expect(asked).toEqual([{ route: 'deep', model: 'deep-model', reasoningEffort: 'high' }])

    // A route that cannot stream still streams through the router.
    const events: LLMStreamEvent[] = []
    for await (const event of adapter.stream!([], [], { provider: 'deep', model: 'deep-model' })) events.push(event)
    expect(events.some(event => event.type === 'message_delta' && event.delta === 'deep')).toBe(true)
  })
})

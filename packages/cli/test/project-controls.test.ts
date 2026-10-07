import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { ProjectHost } from '../src/project-host.js'
import { ApprovalBroker } from '../src/permissions.js'
import { projectSessionRoot, workspaceProjectStateRoot } from '../src/state-storage.js'

const hosts: ProjectHost[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

async function fixture(adapter?: LLMAdapter) {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-project-controls-'))
  roots.push(workspace, workspaceProjectStateRoot(workspace))
  const signals: AbortSignal[] = []
  const llm: LLMAdapter = { async complete(messages, _tools, options) {
    if (messages.some(message => message.role === 'user' && message.content?.includes('Correct the direction'))) {
      return { finishReason: 'stop', content: 'Corrected direction.' }
    }
    const signal = options?.signal
    if (!signal) throw new Error('Run must be cancellable')
    signals.push(signal)
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new Error('Fixture interrupted'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    throw new Error('Fixture should only finish by cancellation')
  } }
  const host = new ProjectHost({ workspace, llm: adapter ?? llm, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker() })
  hosts.push(host)
  const record = await host.create({ name: 'Control' })
  roots.push(projectSessionRoot(workspace, record.id))
  const project = await host.mount(record.id)
  return { host, record, project, signals, workspace }
}

it.each(['coordinator', 'thread'])('publishes separate tool chat messages for a %s and restores them from Box', async target => {
  let calls = 0
  const llm: LLMAdapter = { async complete() {
    calls += 1
    if (calls <= 2) return {
      content: 'Internal execution narration.', finishReason: 'tool_calls',
      toolCalls: [{ id: `chat-${calls}`, name: 'send_project_message', arguments: { message: `Visible message ${calls}` } }],
    }
    return { content: 'Work is complete.', finishReason: 'stop' }
  } }
  const { host, record, project, workspace } = await fixture(llm)
  const id = target === 'coordinator' ? record.coordinatorId
    : (await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Investigate' })).id
  if (target === 'coordinator') await host.sendUserMessage(record.id, 'Start work')
  else await host.sendThreadMessage(record.id, id, 'Start work')
  await expect.poll(async () => (await project.box.timeline()).filter(message => message.sender.id === id && message.kind === 'agent-reply').length).toBe(3)
  const visible = (await project.box.timeline()).filter(message => message.sender.id === id && message.kind === 'agent-reply')
  expect(visible.map(message => message.text)).toEqual(['Visible message 1', 'Visible message 2', 'Work is complete.'])
  await host.dispose()
  const reopened = new ProjectHost({ workspace, llm, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker() })
  hosts.push(reopened)
  const snapshot = await reopened.snapshot(record.id)
  const messages = target === 'coordinator' ? snapshot.messages : snapshot.threadMessages
  expect(messages.filter(message => message.kind === 'agent-reply').map(message => message.text))
    .toEqual(['Visible message 1', 'Visible message 2', 'Work is complete.'])
  expect(messages.some(message => message.text.includes('Internal execution narration'))).toBe(false)
})

it('restores Agent exchanges including nested parent messages in the snapshot', async () => {
  const { host, record, project } = await fixture({ async complete() { return { content: 'Done.', finishReason: 'stop' } } })
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Research' })
  const nested = await project.threads.spawn({ parentId: child.id, goal: 'Verify' })
  const base = { placement: { kind: 'thread' as const, threadId: nested.id }, kind: 'progress' as const }
  const sent = await project.box.send({ ...base, sender: { kind: 'agent', id: child.id }, recipients: [{ kind: 'agent', id: nested.id }], text: 'Use revised scope.' })
  const reply = await project.box.send({ ...base, sender: { kind: 'agent', id: nested.id }, recipients: [{ kind: 'agent', id: child.id }], text: 'Verified the scope.' })
  const direct = await project.box.send({ ...base, sender: { kind: 'user', id: 'user' }, recipients: [{ kind: 'agent', id: nested.id }], text: 'Direct user note.' })
  const snapshot = await host.snapshot(record.id)
  expect(snapshot.agentMessages.map(message => message.messageId)).toEqual(expect.arrayContaining([sent.messageId, reply.messageId]))
  expect(snapshot.agentMessages.some(message => message.messageId === direct.messageId)).toBe(false)
})

it('keeps normal messages asynchronous and interrupts the coordinator for an explicit correction', async () => {
  const { host, record, project, signals } = await fixture()
  await host.sendUserMessage(record.id, 'Start working')
  await expect.poll(() => signals.length).toBe(1)
  await host.sendUserMessage(record.id, 'Additional detail')
  expect(signals[0]?.aborted).toBe(false)
  const correction = await host.sendUserMessage(record.id, 'Correct the direction', undefined, true)
  await expect.poll(() => signals[0]?.aborted).toBe(true)
  await expect.poll(async () => (await project.box.timeline()).some(message => message.kind === 'agent-reply' && message.text === 'Corrected direction.')).toBe(true)
  const events = await project.registry.get(record.coordinatorId)?.session.read()
  expect(events?.filter(event => event.type === 'user/message' && event.payload.name === `box:${correction.messageId}`)).toHaveLength(1)
  expect(events?.some(event => event.type === 'user/message' && event.payload.content === 'Additional detail')).toBe(true)
})

it('stops only the coordinator and can redirect a child Thread independently', async () => {
  const { host, record, project, signals } = await fixture()
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Independent work' })
  await host.sendUserMessage(record.id, 'Start working')
  await expect.poll(() => signals.length).toBe(1)
  await host.sendThreadMessage(record.id, child.id, 'Start child work')
  await expect.poll(() => signals.length).toBe(2)
  expect(await host.stopThread(record.id, record.coordinatorId)).toBe(true)
  expect(signals[0]?.aborted).toBe(true)
  expect(signals[1]?.aborted).toBe(false)
  const correction = await host.sendThreadMessage(record.id, child.id, 'Correct the direction', true)
  await expect.poll(() => signals[1]?.aborted).toBe(true)
  await expect.poll(async () => (await project.box.timeline()).some(message => message.kind === 'agent-reply' && message.sender.id === child.id && message.text === 'Corrected direction.')).toBe(true)
  const events = await project.registry.get(child.id)?.session.read()
  expect(events?.filter(event => event.type === 'user/message' && event.payload.name === `box:${correction.messageId}`)).toHaveLength(1)
})

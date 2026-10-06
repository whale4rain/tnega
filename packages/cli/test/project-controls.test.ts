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

async function fixture() {
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
  const host = new ProjectHost({ workspace, llm, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker() })
  hosts.push(host)
  const record = await host.create({ name: 'Control' })
  roots.push(projectSessionRoot(workspace, record.id))
  const project = await host.mount(record.id)
  return { host, record, project, signals }
}

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

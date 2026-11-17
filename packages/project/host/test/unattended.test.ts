import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { ApprovalBroker } from '@tnega/approval-host'
import { workspaceProjectStateRoot } from '@tnega/home'
import type { ThreadRecord } from '@tnega/thread'
import { ProjectHost, type ThreadMachines, type UnattendedLimits } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** No background memory extraction: it would still write to the project folder while a test removes it. */
const QUIET = { projectMemory: { enabled: false } }

/** Waits for the turn to be stopped; never finishes on its own. */
const hanging: LLMAdapter = {
  complete: (_messages, _tools, options) => new Promise((_done, fail) => {
    const signal = options?.signal
    if (signal?.aborted) fail(new Error('stopped'))
    signal?.addEventListener('abort', () => fail(new Error('stopped')), { once: true })
  }),
}

/** Keeps calling a tool, each answer reporting 300 tokens. */
const spending: LLMAdapter = {
  complete: async () => ({
    finishReason: 'tool_calls',
    toolCalls: [{ id: `call-${Math.random()}`, name: 'list_routines', arguments: {} }],
    usage: { promptTokens: 290, completionTokens: 10 },
  }),
}

async function host(llm: LLMAdapter, unattended: UnattendedLimits, threadMachines?: ThreadMachines): Promise<{ host: ProjectHost; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-unattended-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(workspace), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const projects = new ProjectHost({
    workspace, llm, systemConfig: QUIET, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker(), unattended,
    ...(threadMachines ? { threadMachines } : {}),
  })
  cleanups.push(() => projects.dispose())
  return { host: projects, workspace }
}

it('stops a thread\'s turn that runs past the time limit and marks the thread blocked', async () => {
  const { host: projects } = await host(hanging, { turnMs: 50 })
  const record = await projects.create({ name: 'Slow' })
  const project = await projects.mount(record.id)
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Never ends' })
  const agent = await project.threads.activate(child.id)
  await agent.followup({ text: 'Go' })
  await agent.whenIdle()
  const end = (await agent.session.read()).findLast(event => event.type === 'turn/end')
  expect(end?.payload).toMatchObject({ reason: { kind: 'aborted', cause: { type: 'timeout', timeoutMs: 50 } } })
  await expect.poll(async () => (await project.threads.get(child.id))?.state).toBe('blocked')
  expect((await project.threads.get(child.id))?.detail).toMatch(/limit for unattended work/)
})

it('stops a routine\'s turn that goes over its token budget', async () => {
  const { host: projects } = await host(spending, { routineTokens: 500, turnMs: 60_000 })
  const record = await projects.create({ name: 'Costly' })
  const routine = await projects.createRoutine(record.id, { title: 'Daily', prompt: 'Check things.', schedule: { kind: 'daily', time: '09:00' } })
  await projects.runRoutine(record.id, routine.id)
  const project = await projects.mount(record.id)
  const fact = (await project.routines.list()).find(entry => entry.id === routine.id)
  const threadId = fact?.data.threadId ?? ''
  const agent = await project.threads.activate(threadId)
  // The project loop delivers the run to the thread; wait for that turn to end.
  await expect.poll(async () => (await agent.session.read()).some(event => event.type === 'turn/end'), { timeout: 5_000 }).toBe(true)
  const events = await agent.session.read()
  const end = events.findLast(event => event.type === 'turn/end')
  expect(end?.payload).toMatchObject({ reason: { kind: 'aborted', cause: { type: 'abort' } } })
  // Two answers fit in 500 tokens, the third does not.
  expect(events.filter(event => event.type === 'assistant/message').length).toBeLessThanOrEqual(3)
  await expect.poll(async () => (await project.threads.get(threadId))?.detail).toMatch(/budget of 500/)
})

it('opens a box for each Project thread but not for the coordinator, and forgets them with the project', async () => {
  const opened: string[] = []
  const forgotten: string[] = []
  const machines: ThreadMachines = {
    open: async (thread: ThreadRecord) => {
      opened.push(thread.id)
      return undefined
    },
    forget: async ids => { forgotten.push(...ids) },
  }
  const done: LLMAdapter = { complete: async () => ({ finishReason: 'stop', content: 'ok' }) }
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-thread-boxes-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(workspace), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  // Built-in tools on: only then does a thread get file and command tools, and so a box.
  const projects = new ProjectHost({ workspace, llm: done, systemConfig: QUIET, permission: 'read-only', approvals: new ApprovalBroker(), threadMachines: machines })
  cleanups.push(() => projects.dispose())
  const record = await projects.create({ name: 'Boxed' })
  const project = await projects.mount(record.id)
  await project.threads.activate(record.coordinatorId)
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Build it' })
  await project.threads.activate(child.id)
  expect(opened).toEqual([child.id])
  // A thread in a box gets no worktree on this host.
  expect((await project.threads.get(child.id))?.workspace).toBeUndefined()
  await projects.delete(record.id)
  expect(forgotten.sort()).toEqual([record.coordinatorId, child.id].sort())
})

it('tells the person when the coordinator\'s turn is stopped', async () => {
  const { host: projects } = await host(hanging, { turnMs: 50 })
  const record = await projects.create({ name: 'Stuck coordinator' })
  await projects.sendUserMessage(record.id, 'Plan the week')
  await expect.poll(async () => (await projects.snapshot(record.id)).messages
    .find(envelope => envelope.kind === 'agent-reply')?.text, { timeout: 5_000 }).toMatch(/limit for unattended work/)
  const project = await projects.mount(record.id)
  await expect.poll(async () => (await project.threads.get(record.coordinatorId))?.state).toBe('blocked')
})

it('lets a turn someone is watching run past the time limit', async () => {
  const { host: projects } = await host(hanging, { turnMs: 50 })
  const record = await projects.create({ name: 'Watched' })
  const unwatch = await projects.watch(record.id, { send: () => undefined })
  const project = await projects.mount(record.id)
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Long task' })
  const agent = await project.threads.activate(child.id)
  await agent.followup({ text: 'Go' })
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(agent.status).toBe('running')
  // The window closes: the next check stops it.
  unwatch()
  await agent.whenIdle()
  await expect.poll(async () => (await project.threads.get(child.id))?.state).toBe('blocked')
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agents, type AgentRegistry, type LLMAdapter } from '@tnega/agent'
import { blackboardLocal } from '@tnega/blackboard-local'
import type { BlackboardCommitEvent } from '@tnega/blackboard'
import { agentAddress } from '@tnega/box'
import { boxBlackboard } from '@tnega/box-blackboard'
import { Context } from '@tnega/core'
import { threadLocal } from '@tnega/thread-local'
import { projectLoop } from '@tnega/project-loop'
import { tools, type ToolsService } from '@tnega/tools'
import { ApprovalBroker, permissionGuard } from '../src/permissions.js'
import { mountThreadApprovals } from '../src/thread-approval.js'
import { ProjectHost } from '../src/project-host.js'
import { projectSessionRoot, workspaceProjectStateRoot } from '../src/state-storage.js'

const roots: string[] = []
const contexts: Context[] = []
const hosts: ProjectHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

async function setup(timeoutMs = 120_000, reviewDecision: 'ask' | 'deny' = 'ask') {
  const root = await mkdtemp(join(tmpdir(), 'tnega-thread-approval-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(tools)
  await ctx.plugin(blackboardLocal, { root: join(root, 'blackboard') })
  await ctx.plugin(boxBlackboard, { projectId: '22222222-2222-4222-8222-222222222222' })
  await ctx.plugin(agents)
  await ctx.plugin(threadLocal, {
    projectId: '22222222-2222-4222-8222-222222222222', root, permission: 'workspace-write',
    llm: { complete: async () => ({ content: 'done', finishReason: 'stop' }) },
  })
  const parent = '11111111-1111-4111-8111-111111111111'
  await ctx.threads.ensureRoot({ id: '22222222-2222-4222-8222-222222222222', name: 'Approval', coordinatorId: parent })
  const child = await ctx.threads.spawn({ parentId: parent, goal: 'Run the check', permission: 'workspace-write' })
  const broker = new ApprovalBroker()
  const delegation = mountThreadApprovals(ctx, { projectId: '22222222-2222-4222-8222-222222222222', approvals: broker, timeoutMs })
  const toolService = ctx.get('tools') as ToolsService
  const registry = ctx.get('agents') as AgentRegistry
  toolService.guard(permissionGuard('workspace-write', '22222222-2222-4222-8222-222222222222', broker, {
    workspace: root,
    delegated: id => id === child.id,
    review: async () => ({ decision: reviewDecision, reason: 'Reviewer returned an invalid decision.' }),
    delegateApproval: (request, review) => delegation.request(request, review),
  }))
  let executions = 0
  toolService.register({ schema: { name: 'check', description: 'Check a fixture' }, execute: input => {
    executions += 1
    return input
  } })
  async function approvalId(): Promise<string> {
    await expect.poll(async () => (await ctx.box.inbox(agentAddress(parent))).some(item => item.kind === 'request')).toBe(true)
    const envelope = (await ctx.box.inbox(agentAddress(parent))).find(item => item.kind === 'request')!
    expect(envelope.text).toContain('"tool":"check"')
    expect(envelope.text).toContain('"input":{"value":42}')
    return envelope.messageId
  }
  const start = (signal?: AbortSignal, input: unknown = { value: 42 }) => toolService.execute('check', input, { agentId: child.id, callId: 'original-call', ...(signal ? { signal } : {}) })
  const decide = (id: string, decision: string, agentId = parent) => toolService.execute('decide_thread_approval', {
    request_id: id, decision, reason: 'The check is within the user request.',
  }, { agentId })
  return { ctx, registry, parent, child, broker, delegation, start, decide, approvalId, executions: () => executions }
}

it('automatically routes the exact call and resumes it once after its parent approves', async () => {
  const fixture = await setup()
  const pending = fixture.start()
  const id = await fixture.approvalId()
  expect(fixture.executions()).toBe(0)
  expect((await fixture.decide(id, 'allow')).ok).toBe(true)
  expect(await pending).toMatchObject({ ok: true, output: { value: 42 } })
  expect(fixture.executions()).toBe(1)
  expect((await fixture.decide(id, 'allow')).ok).toBe(false)
  const session = fixture.registry.get(fixture.child.id)!.session
  expect((await session.read()).filter(event => event.type === 'meta').map(event => event.payload))
    .toContainEqual(expect.objectContaining({ kind: 'approval/delegation', requestId: id, callId: 'original-call', decision: 'allow', source: 'parent' }))
})

it('rejects unrelated callers and cannot approve another waiting call with an old decision', async () => {
  const fixture = await setup()
  const pending = fixture.start()
  const id = await fixture.approvalId()
  expect((await fixture.decide(id, 'allow', fixture.child.id)).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
  expect((await fixture.decide(id, 'deny')).ok).toBe(true)
  expect((await pending).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
  const second = fixture.start()
  await expect.poll(async () => (await fixture.ctx.box.timeline()).filter(envelope => envelope.kind === 'request').length).toBe(2)
  expect((await fixture.decide(id, 'allow')).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
  const secondId = (await fixture.ctx.box.timeline()).find(envelope => envelope.kind === 'request' && envelope.messageId !== id)!.messageId
  expect((await fixture.decide(secondId, 'allow')).ok).toBe(true)
  expect((await second).ok).toBe(true)
  expect(fixture.executions()).toBe(1)
})

it('forwards a parent ask-user decision to the existing human approval channel', async () => {
  const fixture = await setup()
  let humanId = ''
  const detach = fixture.broker.attach('22222222-2222-4222-8222-222222222222', event => { humanId = String(event.id) })
  const pending = fixture.start()
  const id = await fixture.approvalId()
  const decision = fixture.decide(id, 'ask-user')
  await expect.poll(() => humanId).not.toBe('')
  expect(fixture.executions()).toBe(0)
  expect(fixture.broker.decide(humanId, '22222222-2222-4222-8222-222222222222', true)).toBe(true)
  expect((await decision).ok).toBe(true)
  expect((await pending).ok).toBe(true)
  detach()
})

it('human escalation displays the complete action, including content beyond 2000 characters', async () => {
  const fixture = await setup()
  let displayedInput = ''
  let humanId = ''
  const detach = fixture.broker.attach('22222222-2222-4222-8222-222222222222', event => {
    displayedInput = String(event.input)
    humanId = String(event.id)
  })
  const input = { command: `echo ${'x'.repeat(2500)}; Remove-Item important.txt` }
  const pending = fixture.start(undefined, input)
  await expect.poll(async () => (await fixture.ctx.box.timeline()).some(envelope => envelope.kind === 'request')).toBe(true)
  const id = (await fixture.ctx.box.timeline()).find(envelope => envelope.kind === 'request')!.messageId
  const deciding = fixture.decide(id, 'ask-user')
  await expect.poll(() => humanId).not.toBe('')
  expect(displayedInput).toBe(JSON.stringify(input))
  fixture.broker.decide(humanId, '22222222-2222-4222-8222-222222222222', false)
  expect((await deciding).ok).toBe(true)
  expect((await pending).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
  detach()
})

it('cancellation invalidates the request and never executes', async () => {
  const fixture = await setup()
  const controller = new AbortController()
  const pending = fixture.start(controller.signal)
  const id = await fixture.approvalId()
  controller.abort()
  expect((await pending).ok).toBe(false)
  expect((await fixture.decide(id, 'allow')).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
})

it('cancelling while a human decision is pending invalidates both approval channels', async () => {
  const fixture = await setup()
  let humanId = ''
  const detach = fixture.broker.attach('22222222-2222-4222-8222-222222222222', event => { humanId = String(event.id) })
  const controller = new AbortController()
  const pending = fixture.start(controller.signal)
  const id = await fixture.approvalId()
  const deciding = fixture.decide(id, 'ask-user')
  await expect.poll(() => humanId).not.toBe('')
  expect((await fixture.decide(id, 'allow')).ok).toBe(false)
  controller.abort()
  expect((await pending).ok).toBe(false)
  expect((await deciding).ok).toBe(false)
  expect(fixture.broker.decide(humanId, '22222222-2222-4222-8222-222222222222', true)).toBe(false)
  expect(fixture.executions()).toBe(0)
  detach()
})

it('a cancelled request delivered later does not leave the Thread waiting', async () => {
  const fixture = await setup()
  const controller = new AbortController()
  const pending = fixture.start(controller.signal)
  const id = await fixture.approvalId()
  controller.abort()
  await pending
  await fixture.ctx.plugin(projectLoop, { projectId: '22222222-2222-4222-8222-222222222222', sweepIntervalMs: 0 })
  await expect.poll(async () => (await fixture.ctx.box.inbox(agentAddress(fixture.parent))).some(envelope => envelope.messageId === id)).toBe(false)
  expect((await fixture.ctx.threads.get(fixture.child.id))?.state).not.toBe('waiting')
})

it('cancellation during the waiting-state write cannot strand the Thread', async () => {
  const fixture = await setup()
  await fixture.ctx.threads.setState(fixture.child.id, 'working')
  const controller = new AbortController()
  const setState = fixture.ctx.threads.setState.bind(fixture.ctx.threads)
  // Inject cancellation at the scheduling boundary, retaining the real store write.
  vi.spyOn(fixture.ctx.threads, 'setState').mockImplementation(async (threadId, state, detail) => {
    if (threadId === fixture.child.id && state === 'waiting') {
      controller.abort()
    }
    return setState(threadId, state, detail)
  })
  expect((await fixture.start(controller.signal)).ok).toBe(false)
  expect((await fixture.ctx.threads.get(fixture.child.id))?.state).not.toBe('waiting')
  expect(fixture.executions()).toBe(0)
  expect((await fixture.ctx.threads.get(fixture.child.id))?.state).toBe('working')
})

it('a deadline ends waiting without executing', async () => {
  const fixture = await setup(30)
  const pending = fixture.start()
  expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringMatching(/timed out/) } })
  expect(fixture.executions()).toBe(0)
})

it('an explicit reviewer denial is terminal and cannot be overridden by a parent', async () => {
  const fixture = await setup(120_000, 'deny')
  expect((await fixture.start()).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
  expect((await fixture.ctx.box.timeline()).filter(envelope => envelope.kind === 'request')).toHaveLength(0)
})

it('disposing the Project cancels its pending approvals and unregisters its decision tool', async () => {
  const fixture = await setup()
  const pending = fixture.start()
  await fixture.approvalId()
  await fixture.ctx.fiber.dispose()
  expect((await pending).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
  expect(fixture.ctx.get('tools', false)).toBeUndefined()
})

it('disposal during the final state update cannot release an already-audited allow', async () => {
  const fixture = await setup()
  const pending = fixture.start()
  const id = await fixture.approvalId()
  await fixture.ctx.threads.setState(fixture.child.id, 'waiting')
  let closing: Promise<void> | undefined
  fixture.ctx.on('blackboard/commit', (event: BlackboardCommitEvent) => {
    if (event.records.some(record => record.id === fixture.child.id && Reflect.get(Object(record.data), 'state') === 'working')) {
      closing = fixture.delegation.dispose()
    }
  })
  await fixture.decide(id, 'allow')
  expect(closing).toBeDefined()
  await closing
  expect((await pending).ok).toBe(false)
  expect(fixture.executions()).toBe(0)
})

it('Project Loop wakes the parent to decide and the same child Agent Run completes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-project-approval-loop-'))
  roots.push(workspace, workspaceProjectStateRoot(workspace))
  let childStarted = false
  let parentDecided = false
  const llm: LLMAdapter = { async complete(messages, availableTools) {
    // The side reviewer deliberately produces the real incident's invalid response.
    if (availableTools.length === 0) return { content: 'invalid review', finishReason: 'stop' }
    const request = messages.find(message => message.role === 'user' && message.content?.includes('Tool permission request '))
    if (request && !parentDecided) {
      parentDecided = true
      const id = /Tool permission request ([0-9a-f-]+)/.exec(request.content ?? '')?.[1]
      if (!id) throw new Error('Missing approval ID in delivered request')
      return { finishReason: 'tool_calls', toolCalls: [{ id: 'parent-decision', name: 'decide_thread_approval', arguments: {
        request_id: id, decision: 'allow', reason: 'The user requested the check.',
      } }] }
    }
    if (!childStarted && messages.some(message => message.content?.includes('Run the fixture check'))) {
      childStarted = true
      return { finishReason: 'tool_calls', toolCalls: [{ id: 'child-original-call', name: 'check', arguments: { value: 42 } }] }
    }
    return { content: 'Check complete', finishReason: 'stop' }
  } }
  const host = new ProjectHost({ workspace, llm, builtinTools: false, permission: 'workspace-write', approvals: new ApprovalBroker() })
  hosts.push(host)
  const record = await host.create({ name: 'Permission loop' })
  roots.push(projectSessionRoot(workspace, record.id))
  const project = await host.mount(record.id)
  let executions = 0
  project.tools.register({ schema: { name: 'check', description: 'Check a fixture' }, execute: () => {
    executions += 1
    return 'checked'
  } })
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Run the fixture check', permission: 'workspace-write' })
  await host.sendThreadMessage(record.id, child.id, 'Run the fixture check')
  await expect.poll(async () => (await project.box.timeline()).some(envelope => envelope.kind === 'complete' && envelope.sender.id === child.id)).toBe(true)
  expect(executions).toBe(1)
  const events = await project.registry.get(child.id)!.session.read()
  expect(events.filter(event => event.type === 'tool/call' && event.payload.name === 'check')).toHaveLength(1)
  expect(events.find(event => event.type === 'tool/result' && event.payload.name === 'check')?.payload).toMatchObject({ ok: true })
  expect(events.flatMap(event => event.type === 'meta' && event.payload.kind === 'approval/delegation' ? [event.payload.decision] : [])).toEqual(['pending', 'allow'])
  // Box persistence precedes the asynchronous delivery that applies terminal state.
  await expect.poll(async () => (await project.threads.get(child.id))?.state).toBe('done')
})

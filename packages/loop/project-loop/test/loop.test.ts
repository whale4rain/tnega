import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agents } from '@tnega/agent'
import { USER_ADDRESS, agentAddress, type BoxEnvelope } from '@tnega/box'
import { Context } from '@tnega/core'
import { tools } from '../../../tools/src/index.js'
import { blackboardLocal } from '../../../project/blackboard-local/src/index.js'
import { boxBlackboard } from '../../../project/box-blackboard/src/index.js'
import { threadLocal } from '../../../project/thread-local/src/index.js'
import { projectLoop } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  // Windows 上文件可能还被后台写入占着，重试比让清理失败更诚实。
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })))
})

const llm = { complete: async () => ({ finishReason: 'stop' as const, content: 'understood' }) }
const project = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Notes',
  coordinatorId: '11111111-1111-4111-8111-111111111111',
  goal: 'Track findings',
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tnega-loop-'))
  directories.push(root)
  return root
}

async function mount(root: string, options: { loop?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin(blackboardLocal, { root: join(root, 'blackboard') })
  await ctx.plugin(boxBlackboard, { projectId: project.id })
  await ctx.plugin(agents)
  await ctx.plugin(threadLocal, { projectId: project.id, root, llm, permission: 'read-only' })
  if (options.loop !== false) {
    await ctx.plugin(projectLoop, { projectId: project.id, sweepIntervalMs: 0 })
  }
  return ctx
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function timeline(ctx: Context): Promise<BoxEnvelope[]> {
  return ctx.box.timeline()
}

it('delivers a user message into the coordinator Session and publishes its reply', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    await ctx.box.send({
      sender: USER_ADDRESS,
      recipients: [agentAddress(coordinator.id)],
      placement: { kind: 'main' },
      kind: 'user-message',
      text: 'What did we decide about the release?',
    })

    const reply = await waitFor(
      async () => (await timeline(ctx)).find(entry => entry.kind === 'agent-reply'),
      'the coordinator reply',
    )
    expect(reply).toMatchObject({
      sender: { kind: 'agent', id: coordinator.id },
      placement: { kind: 'main' },
      text: 'understood',
    })
    // 回复挂在触发它的用户消息上：主对话按因果关系就能还原成一条时间线。
    const userMessage = (await timeline(ctx)).find(entry => entry.kind === 'user-message')!
    expect(reply.causationId).toBe(userMessage.messageId)
    // 发布回复与确认投递是两条路径（前者看 Session，后者看 Box），分别等它们落定。
    await waitFor(
      async () => (await ctx.box.delivery(userMessage.messageId, agentAddress(coordinator.id)))
        ?.status === 'acked' ? true : undefined,
      'the delivery to be acked',
    )

    const session = await ctx.threads.activate(coordinator.id)
    const events = await session.session.read()
    const admitted = events.filter(event => event.type === 'user/message')
    expect(admitted).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('accepts two user messages while the coordinator has not replied yet', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    for (const text of ['first thing', 'and also this']) {
      await ctx.box.send({
        sender: USER_ADDRESS,
        recipients: [agentAddress(coordinator.id)],
        placement: { kind: 'main' },
        kind: 'user-message',
        text,
      })
    }
    await waitFor(
      async () => (await timeline(ctx)).find(entry => entry.kind === 'agent-reply'),
      'the coordinator reply',
    )
    const agent = await ctx.threads.activate(coordinator.id)
    // 两条都在协调者的模型可见历史里，一条都没丢。它们可能落在同一轮（第二条以 steer
    // 进入），也可能各起一轮 —— 顺序不变，缺席才是问题。
    await waitFor(
      async () => {
        const texts = (await agent.session.read())
          .filter(event => event.type === 'user/message')
          .map(event => event.payload.content)
        return texts.length === 2 ? texts : undefined
      },
      'both user messages to be admitted',
    ).then(texts => expect(texts).toEqual(['first thing', 'and also this']))
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps a finished thread result in its thread and out of the main conversation', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Summarise section 2' })
    await ctx.box.send({
      sender: agentAddress(coordinator.id),
      recipients: [agentAddress(child.id)],
      // 派工在时间线上的位置就是卡片的位置：它出现在协调者这轮发言之后。
      placement: { kind: 'main' },
      kind: 'dispatch',
      text: 'Summarise section 2 and report back.',
      threadId: child.id,
    })

    const report = await waitFor(
      async () => (await timeline(ctx))
        .find(entry => entry.kind === 'complete' && entry.sender.id === child.id),
      'the child report',
    )
    expect(report.recipients).toEqual([agentAddress(coordinator.id)])
    await waitFor(
      async () => (await ctx.threads.get(child.id))?.state === 'done' ? true : undefined,
      'the child thread to settle',
    )

    // 结果留在完成它的 Thread 里：它的回复发布在 Thread 自己的时间线上。
    const own = await waitFor(
      async () => (await timeline(ctx)).find(entry => entry.kind === 'agent-reply' && entry.sender.id === child.id),
      'the thread reply in its own thread',
    )
    expect(own.placement).toEqual({ kind: 'thread', threadId: child.id })
    await waitFor(
      async () => (await ctx.box.delivery(report.messageId, agentAddress(coordinator.id)))?.status === 'acked'
        ? true
        : undefined,
      'the report to reach the coordinator',
    )

    // 回报只进协调者的上下文，不起新一轮：主对话里只有派工卡片。
    await new Promise(resolve => setTimeout(resolve, 100))
    const parent = await ctx.threads.activate(coordinator.id)
    expect(parent.status).toBe('idle')
    const main = (await timeline(ctx)).filter(entry => entry.placement.kind === 'main')
    expect(main.map(entry => entry.kind)).toEqual(['dispatch'])
    expect(main[0]).toMatchObject({ threadId: child.id })

    // 用户下一次在主对话里发言时，协调者已经知道这份结果。
    await ctx.box.send({
      sender: USER_ADDRESS,
      recipients: [agentAddress(coordinator.id)],
      placement: { kind: 'main' },
      kind: 'user-message',
      text: 'How did section 2 go?',
    })
    await waitFor(
      async () => (await timeline(ctx)).some(entry => entry.placement.kind === 'main'
        && entry.kind === 'agent-reply' && entry.sender.id === coordinator.id) ? true : undefined,
      'the coordinator answer',
    )
    const events = await parent.session.read()
    const inputs = events.filter(event => event.type === 'user/message')
    expect(inputs.map(event => event.payload.name)).toContain(`box:${report.messageId}`)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('wakes the coordinator when a thread needs a decision', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Pick a licence' })
    await ctx.box.send({
      sender: agentAddress(child.id),
      recipients: [agentAddress(coordinator.id)],
      placement: { kind: 'thread', threadId: child.id },
      kind: 'request',
      text: 'MIT or Apache-2.0?',
    })
    const answer = await waitFor(
      async () => (await timeline(ctx)).find(entry => entry.kind === 'agent-reply' && entry.sender.id === coordinator.id),
      'the coordinator to take up the request',
    )
    expect(answer.placement).toEqual({ kind: 'main' })
    expect((await ctx.threads.get(child.id))?.state).toBe('waiting')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('wakes the coordinator for a report it asked to act on', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Draft the outline', onReport: 'Dispatch the writing thread with the outline' })
    expect((await ctx.threads.get(child.id))?.onReport).toBe('Dispatch the writing thread with the outline')
    await ctx.box.send({
      sender: agentAddress(child.id),
      recipients: [agentAddress(coordinator.id)],
      placement: { kind: 'thread', threadId: child.id },
      kind: 'complete',
      text: 'Outline ready in outline.md.',
    })
    const answer = await waitFor(
      async () => (await timeline(ctx)).find(entry => entry.kind === 'agent-reply' && entry.sender.id === coordinator.id),
      'the coordinator to act on the report',
    )
    expect(answer.placement).toEqual({ kind: 'main' })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('gives the coordinator a long report as its outcome with a pointer to the rest', async () => {
  const { boundReport, COORDINATOR_REPORT_CHARS } = await import('../src/index.js')
  expect(boundReport('  Short and done.  ', 't1')).toBe('Short and done.')
  const long = `Outcome: shipped.\n\n${'Evidence line. '.repeat(200)}`
  const bounded = boundReport(long, 't1')
  expect(bounded.startsWith('Outcome: shipped.')).toBe(true)
  expect(bounded.length).toBeLessThan(COORDINATOR_REPORT_CHARS + 200)
  expect(bounded).toContain('list_threads with thread_id "t1"')

  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Long work' })
    const report = await ctx.box.send({
      sender: agentAddress(child.id),
      recipients: [agentAddress(coordinator.id)],
      placement: { kind: 'thread', threadId: child.id },
      kind: 'complete',
      text: long,
    })
    await waitFor(
      async () => (await ctx.box.delivery(report.messageId, agentAddress(coordinator.id)))?.status === 'acked' ? true : undefined,
      'the report to reach the coordinator',
    )
    const parent = await ctx.threads.activate(coordinator.id)
    expect(parent.status).toBe('idle')
    // Staged input enters the Session with the next turn.
    await ctx.box.send({
      sender: USER_ADDRESS,
      recipients: [agentAddress(coordinator.id)],
      placement: { kind: 'main' },
      kind: 'user-message',
      text: 'Anything new?',
    })
    await waitFor(
      async () => (await timeline(ctx)).some(entry => entry.kind === 'agent-reply' && entry.sender.id === coordinator.id) ? true : undefined,
      'the coordinator answer',
    )
    const input = (await parent.session.read()).find(event => event.type === 'user/message'
      && event.payload.name === `box:${report.messageId}`)
    const content = JSON.stringify(input?.payload)
    expect(content).toContain('Outcome: shipped.')
    expect(content.length).toBeLessThan(COORDINATOR_REPORT_CHARS + 800)
    // The thread keeps the full report for whoever opens it.
    expect((await ctx.threads.get(child.id))?.detail).toBe(long.trim())
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps the coordinator\'s narration of a settled thread request out of the room', async () => {
  const { settledAgentTurn } = await import('../src/index.js')
  const event = (id: string, type: string, payload: Record<string, unknown> = {}) =>
    ({ id, type, ts: 0, payload }) as unknown as import('@tnega/session').SessionEvent
  const turn = (input: string, tool?: string) => [
    event('s', 'turn/start'),
    event('u', 'user/message', { name: `box:${input}`, content: 'x' }),
    ...(tool ? [event('c', 'tool/call', { id: 'c', name: tool, arguments: {} })] : []),
    event('r', 'assistant/message', { content: 'Approved.' }),
  ]
  const fromUser = (id: string) => id === 'human'
  expect(settledAgentTurn(turn('thread-ask', 'decide_thread_approval'), 'r', fromUser)).toBe(true)
  expect(settledAgentTurn(turn('thread-ask', 'send_thread_message'), 'r', fromUser)).toBe(true)
  // A question the coordinator puts to the user, or any turn the user started, is published.
  expect(settledAgentTurn(turn('thread-ask'), 'r', fromUser)).toBe(false)
  expect(settledAgentTurn(turn('human', 'send_thread_message'), 'r', fromUser)).toBe(false)
})

it('attaches artifacts published during a turn to that reply', async () => {
  const root = await workspace()
  const ctx = await mount(root)
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Write the report' })
    const hash = 'a'.repeat(64)
    await ctx.blackboard.commit({
      kind: 'artifact',
      id: hash,
      data: { title: 'Report', hash, size: 12, mediaType: 'text/html' },
      author: child.id,
      expectedVersion: null,
    })
    await ctx.box.send({
      sender: agentAddress(coordinator.id),
      recipients: [agentAddress(child.id)],
      placement: { kind: 'main' },
      kind: 'dispatch',
      text: 'Write the report.',
      threadId: child.id,
    })
    const reply = await waitFor(
      async () => (await timeline(ctx)).find(entry => entry.kind === 'agent-reply' && entry.sender.id === child.id),
      'the thread reply',
    )
    expect(reply.refs).toEqual([{ hash, size: 12, mediaType: 'text/html' }])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('redelivers unacked messages after a restart without re-entering the model', async () => {
  const root = await workspace()
  const first = await mount(root, { loop: false })
  const ids: { coordinator: string; messageId: string } = { coordinator: '', messageId: '' }
  try {
    const coordinator = await first.threads.ensureRoot(project)
    const envelope = await first.box.send({
      sender: USER_ADDRESS,
      recipients: [agentAddress(coordinator.id)],
      placement: { kind: 'main' },
      kind: 'user-message',
      text: 'Delivered after the restart',
    })
    ids.coordinator = coordinator.id
    ids.messageId = envelope.messageId
  } finally {
    await first.fiber.dispose()
  }

  // 第一次挂载时投递到一半（信封已落盘、还没确认）：重启后必须补齐。
  const recovered = await mount(root)
  try {
    const reply = await waitFor(
      async () => (await timeline(recovered)).find(entry => entry.kind === 'agent-reply'),
      'the recovered reply',
    )
    expect(reply).toBeTruthy()
    await waitFor(
      async () => (await recovered.box.delivery(ids.messageId, agentAddress(ids.coordinator)))?.status === 'acked'
        ? true
        : undefined,
      'the delivery to be acked',
    )

    const agent = await recovered.threads.activate(ids.coordinator)
    const events = await agent.session.read()
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(1)
  } finally {
    await recovered.fiber.dispose()
  }

  // 已经确认过的消息不会在第二次恢复里再进入模型。
  const again = await mount(root)
  try {
    // 给恢复扫描一个完整的来回，确认它确实跑了而不是没跑。
    await new Promise(resolve => setTimeout(resolve, 100))
    const agent = await again.threads.activate(ids.coordinator)
    const events = await agent.session.read()
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect((await timeline(again)).filter(entry => entry.kind === 'user-message')).toHaveLength(1)
  } finally {
    await again.fiber.dispose()
  }
})

it('keeps answering the user while a child thread is still running', async () => {
  const root = await workspace()
  // 子 Thread 的模型调用卡在这里，直到测试放行；协调者不受影响。
  let releaseChild: (() => void) | undefined
  const blocking = {
    complete: async (messages: readonly { content?: unknown }[]) => {
      const text = JSON.stringify(messages)
      if (text.includes('Slow child work')) {
        await new Promise<void>(resolve => { releaseChild = resolve })
      }
      return { finishReason: 'stop' as const, content: 'ok' }
    },
  }
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin(blackboardLocal, { root: join(root, 'blackboard') })
  await ctx.plugin(boxBlackboard, { projectId: project.id })
  await ctx.plugin(agents)
  await ctx.plugin(threadLocal, { projectId: project.id, root, llm: blocking, permission: 'read-only' })
  await ctx.plugin(projectLoop, { projectId: project.id, sweepIntervalMs: 0 })
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({ parentId: coordinator.id, goal: 'Slow child work' })

    const ask = async (text: string): Promise<void> => {
      await ctx.box.send({
        sender: USER_ADDRESS,
        recipients: [agentAddress(coordinator.id)],
        placement: { kind: 'main' },
        kind: 'user-message',
        text,
      })
    }
    const replies = async (): Promise<number> =>
      (await ctx.box.timeline()).filter(entry =>
        entry.kind === 'agent-reply' && entry.placement.kind === 'main').length

    await ask('first question')
    await waitFor(async () => (await replies()) >= 1 ? true : undefined, 'the first reply')

    // 派一个会卡住的子 Thread：它开始跑之后，主对话必须还能继续。
    await ctx.box.send({
      sender: agentAddress(coordinator.id),
      recipients: [agentAddress(child.id)],
      placement: { kind: 'main' },
      kind: 'dispatch',
      text: 'Slow child work',
      threadId: child.id,
    })
    await waitFor(
      async () => (await ctx.threads.get(child.id))?.state === 'working' ? true : undefined,
      'the child to start',
    )

    await ask('second question')
    await waitFor(async () => (await replies()) >= 2 ? true : undefined, 'the second reply')

    // 子 Thread 放行之后，它的回报照样进协调者的 inbox。
    releaseChild?.()
    const report = await waitFor(
      async () => (await ctx.box.timeline())
        .find(entry => entry.kind === 'complete' && entry.sender.id === child.id),
      'the child report',
    )
    expect(report.recipients).toEqual([agentAddress(coordinator.id)])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('tells the reader who is speaking and what a reply answers', async () => {
  const { renderEnvelope } = await import('../src/index.js')
  const base = { messageId: 'm2', projectId: project.id, recipients: [], refs: [], createdAt: 2 }
  const label = (id: string) => (id === 'c1' ? 'Licence check' : undefined)
  expect(renderEnvelope({ ...base, sender: agentAddress('c1'), placement: { kind: 'thread', threadId: 'c1' }, kind: 'complete', text: 'MIT is fine.' }, { label }))
    .toBe('[Report from thread "Licence check" (c1)]\n\nMIT is fine.')
  const question = { ...base, messageId: 'm1', sender: agentAddress(project.coordinatorId), placement: { kind: 'main' as const }, kind: 'agent-reply' as const, text: 'Ship Friday or Monday?' }
  expect(renderEnvelope({ ...base, sender: USER_ADDRESS, placement: { kind: 'main' }, kind: 'user-message', text: 'Monday.', causationId: 'm1' }, { label, source: question, reader: project.coordinatorId }))
    .toBe('[In reply to your message: "Ship Friday or Monday?"]\n\nMonday.')
  expect(renderEnvelope({ ...base, sender: agentAddress(project.coordinatorId), placement: { kind: 'main' }, kind: 'dispatch', text: 'Brief.' }, { label }))
    .toBe('Brief.')
})

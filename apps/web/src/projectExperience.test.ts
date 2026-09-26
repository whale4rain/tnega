// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { BootEnvelope, ProjectStreamEvent, SessionEvent } from './project/types'

const workspace = '/alpha'
const projectId = '22222222-2222-4222-8222-222222222222'
const coordinatorId = '11111111-1111-4111-8111-111111111111'
const sessionId = 'session-1'

/** 每条连接都能单独推帧、单独断开，用来验证「不刷新也能看到新消息」和断线重连。 */
interface Connection {
  push: (event: ProjectStreamEvent) => void
  drop: () => void
}
let connections: Connection[] = []
let push: ((event: ProjectStreamEvent) => void) | undefined
let coordinatorEvents: SessionEvent[] = []
let childInboxMessages: BootEnvelope[] = []

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tnega-workspace', workspace)
  localStorage.setItem('tnega-session-selection', JSON.stringify({ [workspace]: sessionId }))
  localStorage.setItem('tnega-recent-projects', JSON.stringify([
    { workspace, id: projectId, name: 'Notes', openedAt: 1 },
  ]))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/config') {
      return json({ apiKeySet: false, models: [], effective: { model: 'm' }, config: {}, env: {} })
    }
    if (url.pathname === '/api/workspaces') return json({ workspaces: [workspace] })
    if (url.pathname === '/api/sessions') return json({ workspace, sessions: [session()] })
    if (url.pathname === `/api/sessions/${sessionId}`) {
      return json({
        summary: session(),
        events: [],
        surface: [],
        context: { tokens: 0, limit: 1, ratio: 0 },
        metrics: { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        running: false,
      })
    }
    if (url.pathname === `/api/projects/${projectId}`) return json(snapshot())
    if (url.pathname === `/api/projects/${projectId}/threads/${coordinatorId}`) {
      return json({ thread: snapshot().threads[0], events: coordinatorEvents })
    }
    if (url.pathname === `/api/projects/${projectId}/stream`) return stream()
    throw new Error(`unexpected request: ${url.pathname}`)
  }))
})

afterEach(() => {
  cleanup()
  connections = []
  coordinatorEvents = []
  childInboxMessages = []
  push = undefined
  vi.unstubAllGlobals()
})

function session() {
  return {
    workspace,
    id: sessionId,
    title: 'Alpha session',
    createdAt: 1,
    updatedAt: 1,
    eventCount: 1,
  }
}

function envelope(
  text: string,
  kind: BootEnvelope['kind'],
  sender: BootEnvelope['sender'],
  overrides: Partial<BootEnvelope> = {},
): BootEnvelope {
  return {
    messageId: `m-${text.length}-${kind}`,
    projectId,
    sender,
    recipients: [{ kind: 'agent', id: coordinatorId }],
    placement: { kind: 'main' },
    kind,
    text,
    refs: [],
    createdAt: 5,
    ...overrides,
  }
}

function snapshot() {
  return {
    project: { id: projectId, name: 'Notes', coordinatorId, createdAt: 1, updatedAt: 1 },
    coordinatorId,
    cursor: 3,
    threads: [{
      id: coordinatorId,
      projectId,
      label: 'Notes',
      goal: 'Track findings',
      state: 'idle',
      depth: 0,
      permission: 'workspace-write',
      createdAt: 1,
      updatedAt: 1,
    }],
    messages: [envelope('Summarise the release notes', 'user-message', { kind: 'user', id: 'user' })],
    inboxMessages: childInboxMessages,
    memory: [],
    library: { artifacts: [], resources: [] },
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sessionEvent<T extends SessionEvent['type']>(
  type: T,
  payload: Extract<SessionEvent, { type: T }>['payload'],
  seq: number,
): SessionEvent {
  return { id: `session-${seq}`, seq, ts: seq, type, payload } as SessionEvent
}

/** 一条开着的 SSE 连接：测试可以随时往里推一帧。 */
function stream(): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'))
      const send = (event: ProjectStreamEvent): void => {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        )
      }
      push = send
      connections.push({ push: send, drop: () => controller.close() })
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * The composer's placeholder belongs to the Astryx contentEditable, which
 * renders it as an element rather than an input `placeholder` attribute, so it
 * is read as text.
 */
const COMPOSER_PLACEHOLDER = 'Ask for something, or add to the work in flight.'

async function openProject(): Promise<void> {
  render(createElement(App))
  await waitFor(() => expect(screen.getByText('Alpha session')).toBeTruthy())
  // Anchored so the row's own overflow button — named "Project actions: Notes"
  // — is not the match.
  const row = await waitFor(() => screen.getByRole('button', { name: /^Notes/ }))
  await act(async () => {
    fireEvent.click(row)
  })
  await waitFor(() => expect(screen.getByText(COMPOSER_PLACEHOLDER)).toBeTruthy())
}

it('keeps showing the project after the session list arrives', async () => {
  await openProject()
  // 顶部这三个面板入口是 Project 屏独有的：出现就说明换屏成功了。
  expect(screen.getByRole('button', { name: 'overview' })).toBeTruthy()

  // 会话列表是异步到的；它不该把刚打开的 Project 挤回会话屏。
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  expect(screen.getByText(COMPOSER_PLACEHOLDER)).toBeTruthy()
  expect(screen.getByText('Summarise the release notes')).toBeTruthy()
})

it('renders a message pushed over the stream without a refresh', async () => {
  await openProject()
  expect(push).toBeTypeOf('function')

  await act(async () => {
    push?.({
      type: 'message',
      seq: 9,
      envelope: envelope('notes look good', 'agent-reply', { kind: 'agent', id: coordinatorId }),
    })
  })

  expect(await screen.findByText('notes look good')).toBeTruthy()
})

it('follows the project again after the stream drops', async () => {
  await openProject()
  await waitFor(() => expect(connections).toHaveLength(1), { timeout: 3_000 })

  // 服务重启、网络抖动、后台标签页被节流都会把流掐断：客户端自己按游标接回来。
  await act(async () => {
    connections[0]!.drop()
  })
  await waitFor(() => expect(connections.length).toBeGreaterThan(1), { timeout: 4_000 })

  await act(async () => {
    connections.at(-1)!.push({
      type: 'message',
      seq: 12,
      envelope: envelope('still following', 'agent-reply', { kind: 'agent', id: coordinatorId }),
    })
  })
  expect(await screen.findByText('still following')).toBeTruthy()
})

it('shows the reply while it is still being written', async () => {
  await openProject()
  await waitFor(() => expect(connections).toHaveLength(1))

  await act(async () => {
    const connection = connections[0]!
    connection.push({ type: 'agent-status', agentId: coordinatorId, status: 'running' })
    connection.push({ type: 'chunk', agentId: coordinatorId, text: 'notes ' })
    connection.push({ type: 'chunk', agentId: coordinatorId, text: 'look good' })
  })

  // 整轮还没结束、回复还没发布，正文就已经在屏幕上。
  expect(await screen.findByText(/notes look good/)).toBeTruthy()

  // 回复发布之后由那一条取代，不会两份都在。
  await act(async () => {
    connections[0]!.push({
      type: 'message',
      seq: 9,
      envelope: envelope('notes look good', 'agent-reply', { kind: 'agent', id: coordinatorId }),
    })
  })
  await waitFor(() => expect(screen.getAllByText(/notes look good/)).toHaveLength(1))
})

it('shows coordinator tool calls from its existing Session log', async () => {
  coordinatorEvents = [
    sessionEvent('turn/start', { turn: 1 }, 1),
    sessionEvent('tool/call', {
      id: 'call-1', name: 'list_threads', arguments: { wait_ms: 30_000 },
    }, 2),
  ]
  await openProject()
  expect((await screen.findAllByText('list_threads')).length).toBeGreaterThan(0)
})

it('renders child inbox messages as a Subagent card', async () => {
  childInboxMessages = [envelope(
    'Child is still working.',
    'progress',
    { kind: 'agent', id: '33333333-3333-4333-8333-333333333333' },
    { placement: { kind: 'thread', threadId: '33333333-3333-4333-8333-333333333333' } },
  )]
  await openProject()
  const card = screen.getByRole('button', { name: /Subagent.*Child is still working\./ })
  expect(card.closest('.subagent-card')).toBeTruthy()
  expect(screen.queryByText(/Message received from a thread:/)).toBeNull()
  fireEvent.click(card)
  expect(screen.getAllByText(/Child is still working\./).length).toBeGreaterThan(0)
})

it('opens a side panel from the header switcher and closes it on a second click', async () => {
  await openProject()
  const switcher = screen.getByRole('group', { name: 'Project panels' })
  const memory = within(switcher).getByRole('button', { name: 'memory' })

  fireEvent.click(memory)
  expect(await screen.findByText(/Nothing remembered yet/)).toBeTruthy()
  expect(memory.getAttribute('aria-pressed')).toBe('true')

  // 单选组的语义：再点当前项就是收起。
  fireEvent.click(memory)
  expect(screen.queryByText(/Nothing remembered yet/)).toBeNull()
  expect(within(switcher).getByRole('button', { name: 'memory' }).getAttribute('aria-pressed')).toBe('false')
})

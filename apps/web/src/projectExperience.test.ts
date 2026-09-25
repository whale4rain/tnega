// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'

const workspace = '/alpha'
const projectId = '22222222-2222-4222-8222-222222222222'
const coordinatorId = '11111111-1111-4111-8111-111111111111'
const sessionId = 'session-1'

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
    if (url.pathname === '/api/sessions') {
      return json({
        workspace,
        sessions: [{
          workspace,
          id: sessionId,
          title: 'Alpha session',
          createdAt: 1,
          updatedAt: 1,
          eventCount: 1,
        }],
      })
    }
    if (url.pathname === `/api/sessions/${sessionId}`) {
      return json({
        summary: {
          workspace,
          id: sessionId,
          title: 'Alpha session',
          createdAt: 1,
          updatedAt: 1,
          eventCount: 1,
        },
        events: [],
        surface: [],
        context: { tokens: 0, limit: 1, ratio: 0 },
        metrics: { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        running: false,
      })
    }
    if (url.pathname === `/api/projects/${projectId}`) {
      return json({
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
        messages: [{
          messageId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          projectId,
          sender: { kind: 'user', id: 'user' },
          recipients: [{ kind: 'agent', id: coordinatorId }],
          placement: { kind: 'main' },
          kind: 'user-message',
          text: 'Summarise the release notes',
          refs: [],
          createdAt: 5,
        }],
        memory: [],
        library: { artifacts: [], resources: [] },
      })
    }
    if (url.pathname === `/api/projects/${projectId}/stream`) return openStream()
    throw new Error(`unexpected request: ${url.pathname}`)
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一条一直开着的 SSE 连接：测试只关心界面，不关心推送。 */
function openStream(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': connected\n\n'))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

it('keeps showing the project after the session list arrives', async () => {
  render(createElement(App))

  await waitFor(() => expect(screen.getByText('Alpha session')).toBeTruthy())
  const row = await waitFor(() => screen.getByRole('button', { name: /Notes/ }))
  await act(async () => {
    fireEvent.click(row)
  })

  // Project 屏在主区里：它自己的输入框就是标志。
  await waitFor(() =>
    expect(screen.getByPlaceholderText('Ask for something, or add to the work in flight.')).toBeTruthy())
  // 应用级侧边栏是 Project 屏独有的：它出现就说明换屏成功了。
  expect(screen.getByRole('button', { name: 'Customize' })).toBeTruthy()

  // 会话列表是异步到的；它不该把刚打开的 Project 挤回会话屏。
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  expect(screen.getByPlaceholderText('Ask for something, or add to the work in flight.')).toBeTruthy()
  expect(screen.getByText('Summarise the release notes')).toBeTruthy()
})

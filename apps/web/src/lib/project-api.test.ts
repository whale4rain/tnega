// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { projectApi } from './project-api'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

it('sends interruption explicitly for project and thread messages while keeping ordinary sends asynchronous', async () => {
  const requests: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ path: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ messageId: 'message', createdAt: 1 }), { status: 200 })
  }))
  await projectApi.send('workspace', 'project', 'Steer')
  await projectApi.send('workspace', 'project', 'Correct', 'reply', true)
  await projectApi.sendToThread('workspace', 'project', 'worker', 'Steer')
  await projectApi.sendToThread('workspace', 'project', 'worker', 'Correct', true)
  expect(requests.map(request => request.body)).toEqual([
    { text: 'Steer' }, { text: 'Correct', replyTo: 'reply', interrupt: true },
    { text: 'Steer' }, { text: 'Correct', interrupt: true },
  ])
  expect(requests[3]?.path).toContain('/threads/worker/messages?')
})

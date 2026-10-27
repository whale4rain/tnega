import { describe, expect, it } from 'vitest'
import type { CDPSession, Page } from 'playwright-core'
import { LiveView } from '../src/live.js'

/**
 * A Page shaped like the part of Playwright that LiveView touches, with a CDP session
 * whose `Page.startScreencast` can be made to fail. That failure is what Chromium
 * answers during a cross-renderer navigation ("Not attached to an active page"), and
 * it used to leave the view permanently dark.
 */
function fakePage(options: { failStarts?: number } = {}) {
  const listeners = new Map<string, ((frame: unknown) => void)[]>()
  let starts = 0
  const session = {
    on(event: string, listener: (frame: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return session
    },
    async send(method: string) {
      if (method === 'Page.startScreencast') {
        starts += 1
        if (starts <= (options.failStarts ?? 0)) {
          throw new Error('Protocol error (Page.startScreencast): Not attached to an active page')
        }
      }
      return {}
    },
    async detach() {},
  }
  const page = {
    context: () => ({ newCDPSession: async () => session as unknown as CDPSession }),
    viewportSize: () => ({ width: 640, height: 480 }),
    evaluate: async () => ({ width: 640, height: 480 }),
    once: () => page,
    url: () => 'about:blank',
    title: async () => 'blank',
  }
  return {
    page: page as unknown as Page,
    starts: () => starts,
    /** Push one screencast frame, as Chromium does after a paint. */
    paint(width = 640) {
      for (const listener of listeners.get('Page.screencastFrame') ?? []) {
        listener({ data: 'jpeg', sessionId: starts, metadata: { deviceWidth: width, deviceHeight: 480 } })
      }
    },
  }
}

const waitFor = async (probe: () => boolean, what: string, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('live view start-up', () => {
  it('retries a start that lost the navigation race instead of staying dark', async () => {
    const fake = fakePage({ failStarts: 1 })
    const view = new LiveView(async () => fake.page)
    const frames: number[] = []
    const off = view.subscribe(event => { if (event.type === 'frame') frames.push(event.width) })

    // The first attempt throws; the same subscription must still get frames.
    await waitFor(() => fake.starts() >= 2, 'the retry')
    fake.paint()
    await waitFor(() => frames.length > 0, 'a frame')
    expect(frames).toEqual([640])
    off()
    await view.close()
  })

  it('does not treat a half-started session as running', async () => {
    const fake = fakePage({ failStarts: 1 })
    const view = new LiveView(async () => fake.page)
    const off = view.subscribe(() => {})

    await waitFor(() => fake.starts() === 1, 'the failed attempt')
    // A session published before `startScreencast` succeeded would block the retry.
    expect((view as unknown as { _session?: unknown })._session).toBeUndefined()
    await waitFor(() => fake.starts() === 2, 'the retry')
    expect((view as unknown as { _session?: unknown })._session).toBeDefined()
    off()
    await view.close()
  })

  it('stops retrying when nobody is watching any more', async () => {
    const fake = fakePage({ failStarts: 10 })
    const view = new LiveView(async () => fake.page)
    const off = view.subscribe(() => {})
    await waitFor(() => fake.starts() >= 1, 'the first attempt')
    off()
    // Every attempt fails and the watcher is gone: no further starts should follow.
    await new Promise(resolve => setTimeout(resolve, 400))
    const starts = fake.starts()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(fake.starts()).toBe(starts)
    await view.close()
  })

  it('gives up after a bounded number of attempts', async () => {
    const fake = fakePage({ failStarts: 99 })
    const view = new LiveView(async () => fake.page)
    const off = view.subscribe(() => {})
    await new Promise(resolve => setTimeout(resolve, 1_500))
    // One attempt plus the retry budget; it must not spin forever.
    expect(fake.starts()).toBeLessThanOrEqual(4)
    off()
    await view.close()
  })
})

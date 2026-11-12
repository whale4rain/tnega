import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { DaemonLink } from '@tnega/daemon-protocol'
import { DaemonWaitTimeout, daemons } from '../src/index.js'

function fakeLink(deviceId = 'dev_x'): DaemonLink & { reasons: string[] } {
  const listeners = new Set<(reason?: string) => void>()
  const reasons: string[] = []
  let closed = false
  return {
    deviceId,
    protocolVersion: 2,
    capabilities: { fs: true, process: true, http: true, platform: 'linux' },
    workspaces: [],
    get closed() { return closed },
    reasons,
    call: () => Promise.reject(new Error('not used')),
    onNotification: () => () => undefined,
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close(reason) {
      if (closed) return
      closed = true
      reasons.push(reason ?? '')
      for (const listener of listeners) listener(reason)
    },
  }
}

async function registry() {
  const ctx = new Context()
  await ctx.plugin(daemons)
  return { ctx, registry: ctx.get('daemons') }
}

describe('ctx.daemons', () => {
  it('hands a waiting run the link once its device connects, and forgets it when it closes', async () => {
    const { registry: live } = await registry()
    const events: string[] = []
    live.on((event, daemon) => events.push(`${event} ${daemon.deviceId}`))
    const waiting = live.wait('d1', 5_000)
    const link = fakeLink()
    live.add({ deviceId: 'd1', accountId: 'a1', link })
    expect((await waiting).link).toBe(link)
    expect(live.get('d1')?.accountId).toBe('a1')
    link.close('gone')
    expect(live.get('d1')).toBeUndefined()
    expect(live.list()).toEqual([])
    expect(events).toEqual(['connected d1', 'disconnected d1'])
  })

  it('keeps one link per device: a reconnect replaces and closes the old one', async () => {
    const { registry: live } = await registry()
    const first = fakeLink()
    const second = fakeLink()
    live.add({ deviceId: 'd1', accountId: 'a1', link: first })
    live.add({ deviceId: 'd1', accountId: 'a1', link: second })
    expect(first.reasons).toEqual(['replaced by a new connection'])
    // The old link closing does not remove the new one.
    expect(live.get('d1')?.link).toBe(second)
  })

  it('gives up waiting after the timeout or an abort', async () => {
    const { registry: live } = await registry()
    await expect(live.wait('nobody', 20)).rejects.toBeInstanceOf(DaemonWaitTimeout)
    const controller = new AbortController()
    const waiting = live.wait('nobody', 5_000, controller.signal)
    controller.abort(new Error('run cancelled'))
    await expect(waiting).rejects.toThrow('run cancelled')
  })

  it('closes every link when the scope is disposed', async () => {
    const { ctx, registry: live } = await registry()
    const link = fakeLink()
    live.add({ deviceId: 'd1', accountId: 'a1', link })
    await ctx.fiber.dispose()
    expect(link.reasons).toEqual(['runtime stopped'])
  })
})

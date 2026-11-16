import { expect, it } from 'vitest'
import type { DaemonLink } from '@tnega/daemon-protocol'
import { LeasedLink, type MachineLease } from '../src/index.js'

/** A daemon link that answers `process/start` with a handle and lets the test send notifications. */
function scriptedLink(): { link: DaemonLink; notify: (method: string, params: unknown) => void } {
  const listeners = new Map<string, Set<(params: unknown) => void>>()
  const link: DaemonLink = {
    deviceId: 'box',
    protocolVersion: 2,
    capabilities: { fs: true, process: true, http: true, platform: 'linux' },
    workspaces: [{ id: 'ws', path: '/workspace' }],
    closed: false,
    call: async method => {
      if (method === 'process/start') return { handle: 'h1', pid: 7 }
      return null
    },
    onNotification(method, listener) {
      const set = listeners.get(method) ?? new Set()
      listeners.set(method, set)
      set.add(listener)
      return () => { set.delete(listener) }
    },
    onClose: () => () => undefined,
    close: () => undefined,
  }
  return { link, notify: (method, params) => { for (const listener of listeners.get(method) ?? []) listener(params) } }
}

function leases(link: DaemonLink): { acquire: () => Promise<MachineLease>; released: () => number } {
  let released = 0
  return {
    acquire: async () => ({ machineId: 'm', deviceId: 'box', link, workspacePath: '/workspace', release: () => { released += 1 } }),
    released: () => released,
  }
}

const settle = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

it('keeps the box\'s lease while a background process runs, and lets go once it exits', async () => {
  const { link, notify } = scriptedLink()
  const pool = leases(link)
  const leased = await LeasedLink.open({ acquire: pool.acquire, idleMs: 10 })
  await leased.call('process/start', { workspaceId: 'ws', callId: 'c1', cwd: '/workspace', command: 'sleep 600' })
  await settle(40)
  // Pausing the box now would freeze the process: the lease stays.
  expect(leased.leased).toBe(true)
  expect(leased.holding).toBe(1)
  notify('process/exit', { handle: 'h1', exitCode: 0 })
  await settle(40)
  expect(leased.leased).toBe(false)
  expect(pool.released()).toBe(1)
  leased.close()
})

it('keeps the lease while a stream is open, until it ends', async () => {
  const { link, notify } = scriptedLink()
  const pool = leases(link)
  const leased = await LeasedLink.open({ acquire: pool.acquire, idleMs: 10 })
  await leased.call('stream/open', { service: 'terminals', method: 'attach', args: [], stream: 's1' })
  await settle(40)
  expect(leased.leased).toBe(true)
  notify('stream/end', { stream: 's1', reason: 'done' })
  await settle(40)
  expect(leased.leased).toBe(false)
  leased.close()
})

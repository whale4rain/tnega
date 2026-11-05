import { expect, it } from 'vitest'
import { Peer, memoryTransportPair } from '@tnega/daemon-protocol'
import { StreamHub } from '../src/index.js'

const tick = (): Promise<void> => new Promise(done => setTimeout(done, 0))

/** A runtime-side peer that records what the hub sends it. */
function connect(hub: StreamHub) {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const daemon = new Peer(daemonSide, { heartbeat: false })
  const runtime = new Peer(runtimeSide, { heartbeat: false })
  const seen: unknown[] = []
  runtime.onNotification('stream/event', params => seen.push(params))
  runtime.onNotification('stream/end', params => seen.push(params))
  hub.attach(daemon)
  return { daemon, runtime, seen }
}

it('holds an end that happens while the stream waits for a resume, and sends it after the replay', async () => {
  const hub = new StreamHub({ graceMs: 5_000 })
  let emit: (event: unknown) => void = () => undefined
  let end: (reason: string) => void = () => undefined
  let unsubscribed = 0
  const first = connect(hub)
  await hub.open('s1', (_args, onEvent, onEnd) => { emit = onEvent; end = onEnd; return () => { unsubscribed += 1 } }, [])
  emit('a')
  await tick()
  first.runtime.close('blip')
  await tick()
  emit('b')
  end('terminal closed')
  emit('ignored')
  expect(unsubscribed).toBe(1)
  expect(hub.size).toBe(1)

  const second = connect(hub)
  await tick()
  expect(second.seen).toEqual([])
  expect(hub.resume('s1', 1)).toBe(1)
  await tick()
  expect(second.seen).toEqual([
    { stream: 's1', seq: 2, event: 'b' },
    { stream: 's1', reason: 'terminal closed' },
  ])
  expect(hub.size).toBe(0)
  expect(unsubscribed).toBe(1)
  hub.dispose()
  second.runtime.close()
})

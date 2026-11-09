import { expect, it } from 'vitest'
import { SessionLog, SessionNotFoundError, type SessionBackend, type SessionEvent, type SessionLoad } from '../src/index.js'

/** A log kept in memory, standing in for a server's rows. */
class MemoryBackend implements SessionBackend {
  readonly stored: SessionEvent[] = []
  readonly calls: string[] = []
  readonly holders = new Set<object>()
  damaged = false
  constructor(readonly key: string) {}

  async load(): Promise<SessionLoad | undefined> {
    this.calls.push('load')
    return this.stored.length ? { events: structuredClone(this.stored), damaged: this.damaged } : undefined
  }
  async heldElsewhere(): Promise<boolean> { return false }
  async hold(owner: object): Promise<void> { this.holders.add(owner) }
  async release(owner: object): Promise<void> { this.holders.delete(owner) }
  async create(first: SessionEvent): Promise<void> { this.calls.push('create'); this.stored.push(structuredClone(first)) }
  async append(events: readonly SessionEvent[]): Promise<void> { this.calls.push(`append:${events.length}`); this.stored.push(...structuredClone(events)) }
  async sync(): Promise<void> { this.calls.push('sync') }
  async repair(closers: readonly SessionEvent[]): Promise<void> {
    this.calls.push(`repair:${closers.length}`)
    this.damaged = false
    this.stored.push(...structuredClone(closers))
  }
}

it('keeps a session on any backend: create, append, flush and read back', async () => {
  const backend = new MemoryBackend('memory:one')
  const log = new SessionLog(backend)
  expect(log.file).toBe('memory:one')
  await log.init()
  await log.append('user/message', { content: 'hi' })
  expect(await log.flush()).toBe(2)
  expect(backend.calls).toEqual(['load', 'create', 'append:1', 'sync'])
  expect(backend.holders.size).toBe(1)
  await log.close()
  expect(backend.holders.size).toBe(0)

  const again = SessionLog.readOnly(backend)
  expect((await again.read()).map(event => event.type)).toEqual(['meta', 'user/message'])
  expect(await again.deriveMessages()).toEqual([{ role: 'user', content: 'hi' }])
})

it('asks the backend to repair a crashed turn, with the closers to store', async () => {
  const backend = new MemoryBackend('memory:two')
  const log = new SessionLog(backend)
  await log.append('tool/call', { id: 'c1', name: 'read', arguments: {} })
  await log.flush()
  await log.close()

  // Reopened after a crash: the call has no result yet.
  const reopened = new SessionLog(backend)
  await reopened.init()
  expect(backend.calls.filter(call => call.startsWith('repair'))).toEqual(['repair:1'])
  expect(backend.stored.at(-1)).toMatchObject({ type: 'tool/result', payload: { toolCallId: 'c1' } })
  await reopened.close()
})

it('reports a missing session to a reader without creating one', async () => {
  const backend = new MemoryBackend('memory:none')
  await expect(SessionLog.readOnly(backend).read()).rejects.toBeInstanceOf(SessionNotFoundError)
  expect(backend.calls).toEqual(['load'])
})

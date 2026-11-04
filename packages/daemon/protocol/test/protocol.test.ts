import { describe, expect, it } from 'vitest'
import {
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  Peer,
  RemoteError,
  RpcError,
  RpcErrorCode,
  acceptDaemon,
  encodeBytes,
  initialize,
  isConnectionLost,
  memoryTransportPair,
} from '../src/index.js'

const tick = (ms = 0): Promise<void> => new Promise(done => setTimeout(done, ms))

describe('peer', () => {
  it('answers requests and keeps the error name and code across the wire', async () => {
    const [left, right] = memoryTransportPair()
    const client = new Peer(left, { heartbeat: false })
    new Peer(right, {
      heartbeat: false,
      handle: async (method, params) => {
        if (method === 'echo') return params
        const error = Object.assign(new Error('no such file'), { code: 'ENOENT' })
        error.name = 'Error'
        throw error
      },
    })
    expect(await client.request('echo', { a: 1 })).toEqual({ a: 1 })
    const failure = await client.request('missing', {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect(failure).toMatchObject({ message: 'no such file', code: 'ENOENT', rpcCode: RpcErrorCode.CALL_FAILED })
  })

  it('cancels a running call with $/cancel and aborts the handler', async () => {
    const [left, right] = memoryTransportPair()
    const client = new Peer(left, { heartbeat: false })
    let aborted = false
    new Peer(right, {
      heartbeat: false,
      handle: async (_method, _params, context) => await new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
      }),
    })
    const controller = new AbortController()
    const pending = client.request('slow', {}, { signal: controller.signal })
    await tick()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ rpcCode: RpcErrorCode.REQUEST_CANCELLED })
    await tick()
    expect(aborted).toBe(true)
  })

  it('fails pending calls and aborts handlers when the connection closes', async () => {
    const [left, right] = memoryTransportPair()
    const client = new Peer(left, { heartbeat: false })
    let aborted = false
    new Peer(right, {
      heartbeat: false,
      handle: async (_method, _params, context) => await new Promise(() => {
        context.signal.addEventListener('abort', () => { aborted = true })
      }),
    })
    const pending = client.request('forever', {})
    await tick()
    right.close('gone')
    const error = await pending.catch((reason: unknown) => reason)
    expect(isConnectionLost(error)).toBe(true)
    await tick()
    expect(aborted).toBe(true)
    await expect(client.request('after', {})).rejects.toMatchObject({ rpcCode: RpcErrorCode.CONNECTION_LOST })
  })

  it('drops a connection that goes silent past the heartbeat timeout', async () => {
    const [left] = memoryTransportPair()
    // The far side never answers: nothing is heard after the start.
    const peer = new Peer(left, { heartbeat: { intervalMs: 10, timeoutMs: 40 } })
    const closed = new Promise<string | undefined>(done => peer.onClose(done))
    expect(await closed).toBe('heartbeat lost')
  })

  it('keeps a connection whose peer sends heartbeats', async () => {
    const [left, right] = memoryTransportPair()
    const a = new Peer(left, { heartbeat: { intervalMs: 10, timeoutMs: 40 } })
    const b = new Peer(right, { heartbeat: { intervalMs: 10, timeoutMs: 40 } })
    await tick(120)
    expect(a.closed).toBe(false)
    expect(b.closed).toBe(false)
    a.close()
  })

  it('refuses a payload over the cap before sending it', () => {
    expect(() => encodeBytes(new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toThrow(/exceeds/)
  })
})

describe('handshake', () => {
  async function handshake(version: number) {
    const [runtimeSide, daemonSide] = memoryTransportPair()
    const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
    const daemon = new Peer(daemonSide, { heartbeat: false, handle: async () => 'served' })
    const answer = initialize(daemon, {
      protocolVersion: version,
      deviceId: 'dev_1',
      capabilities: { fs: true },
      workspaces: [{ id: 'ws_1', path: '/w' }],
    })
    return { accepted, answer, daemon }
  }

  it('accepts this version and the one before', async () => {
    for (const version of [PROTOCOL_VERSION, PROTOCOL_VERSION - 1]) {
      const { accepted, answer } = await handshake(version)
      expect(await answer).toMatchObject({ protocolVersion: version })
      const link = await accepted
      expect(link).toMatchObject({ deviceId: 'dev_1', protocolVersion: version, workspaces: [{ id: 'ws_1', path: '/w' }] })
      expect(await link.call('fs/realRoot', { workspaceId: 'ws_1' })).toBe('served')
      link.close()
    }
  })

  it('refuses a version outside N and N-1 and hangs up', async () => {
    const { accepted, answer, daemon } = await handshake(PROTOCOL_VERSION + 1)
    await expect(answer).rejects.toMatchObject({ rpcCode: RpcErrorCode.VERSION_REFUSED })
    await expect(accepted).rejects.toBeInstanceOf(RpcError)
    await tick(5)
    expect(daemon.closed).toBe(true)
  })

  it('refuses calls before initialize', async () => {
    const [runtimeSide, daemonSide] = memoryTransportPair()
    void acceptDaemon(runtimeSide, { heartbeat: false }).catch(() => undefined)
    const daemon = new Peer(daemonSide, { heartbeat: false })
    await expect(daemon.request('fs/stat', {})).rejects.toMatchObject({ rpcCode: RpcErrorCode.NOT_INITIALIZED })
    daemon.close()
  })

  it('gives mutating calls an id so a retry is recognisable', async () => {
    const [runtimeSide, daemonSide] = memoryTransportPair()
    const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
    const seen: unknown[] = []
    const daemon = new Peer(daemonSide, { heartbeat: false, handle: async (_method, params) => { seen.push(params); return null } })
    await initialize(daemon, { deviceId: 'd', capabilities: {}, workspaces: [{ id: 'w', path: '/w' }] })
    const link = await accepted
    await link.call('fs/mkdir', { workspaceId: 'w', path: 'a' })
    await link.call('fs/stat', { workspaceId: 'w', path: 'a' })
    expect(seen[0]).toMatchObject({ callId: expect.any(String) })
    expect(seen[1]).not.toHaveProperty('callId')
    link.close()
  })
})

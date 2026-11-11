import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { TransportBase, type Transport } from '@tnega/daemon-protocol'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** The largest message a daemon may send in one go (files travel base64 in JSON). */
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024

/** Why an upgrade request is not a WebSocket handshake this server takes, or `undefined`. */
export function handshakeProblem(req: IncomingMessage): string | undefined {
  if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return 'not a WebSocket upgrade'
  if (req.headers['sec-websocket-version'] !== '13') return 'WebSocket version 13 only'
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return 'missing or bad Sec-WebSocket-Key'
  return undefined
}

/** Refuse an upgrade with a plain HTTP answer and close the socket. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  const text = `${reason}\n`
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request'}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`)
}

/**
 * The server's end of one WebSocket (RFC 6455): text messages, fragments,
 * ping and close. Client frames must be masked; a message over
 * {@link MAX_MESSAGE_BYTES} or a protocol error closes the connection.
 */
export class ServerWebSocket extends TransportBase implements Transport {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentBytes = 0

  private constructor(private readonly socket: Duplex) {
    super()
    socket.on('data', (chunk: Buffer) => this.read(chunk))
    socket.on('close', () => this.markClosed('connection closed'))
    socket.on('error', () => this.markClosed('socket error'))
  }

  /** Answer the handshake ({@link handshakeProblem} must have passed); the socket then carries frames. */
  static accept(req: IncomingMessage, socket: Duplex, head: Buffer): ServerWebSocket {
    const key = String(req.headers['sec-websocket-key'])
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
    const transport = new ServerWebSocket(socket)
    if (head.length) transport.read(head)
    return transport
  }

  send(message: string): void {
    if (this.closed) throw new Error('transport is closed')
    this.frame(0x1, Buffer.from(message, 'utf8'))
  }

  close(reason?: string): void {
    if (!this.markClosed(reason)) return
    const text = Buffer.from((reason ?? '').slice(0, 120), 'utf8')
    const code = Buffer.alloc(2)
    code.writeUInt16BE(1000)
    this.frame(0x8, Buffer.concat([code, text]))
    this.socket.end()
  }

  private fail(reason: string, code = 1002): void {
    if (this.closed) return
    const status = Buffer.alloc(2)
    status.writeUInt16BE(code)
    this.frame(0x8, status)
    this.markClosed(reason)
    this.socket.end()
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || this.socket.writableEnded) return
    let head: Buffer
    if (payload.length < 126) {
      head = Buffer.from([0x80 | opcode, payload.length])
    } else if (payload.length < 65_536) {
      head = Buffer.alloc(4)
      head[0] = 0x80 | opcode
      head[1] = 126
      head.writeUInt16BE(payload.length, 2)
    } else {
      head = Buffer.alloc(10)
      head[0] = 0x80 | opcode
      head[1] = 127
      head.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    this.socket.write(Buffer.concat([head, payload]))
  }

  private read(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (!this.closed) {
      if (this.buffer.length < 2) return
      const first = this.buffer.readUInt8(0)
      const second = this.buffer.readUInt8(1)
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      if ((first & 0x70) !== 0) return this.fail('reserved bits set')
      if ((second & 0x80) === 0) return this.fail('client frames must be masked')
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) return this.fail('message too large', 1009)
        length = Number(big)
        offset = 10
      }
      if (length > MAX_MESSAGE_BYTES) return this.fail('message too large', 1009)
      if (this.buffer.length < offset + 4 + length) return
      const mask = this.buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length))
      for (let index = 0; index < payload.length; index++) payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index)
      this.buffer = this.buffer.subarray(offset + 4 + length)
      if (opcode >= 0x8) {
        if (!fin || length > 125) return this.fail('bad control frame')
        if (opcode === 0x8) {
          this.close(payload.length > 2 ? `closed by the daemon: ${payload.subarray(2).toString('utf8')}` : 'closed by the daemon')
          return
        }
        if (opcode === 0x9) this.frame(0xa, payload)
        continue
      }
      if (opcode === 0x2) return this.fail('binary messages are not part of this protocol', 1003)
      if (opcode === 0x1 && this.fragments.length) return this.fail('new message inside a fragmented one')
      if (opcode === 0x0 && !this.fragments.length) return this.fail('continuation without a message')
      if (opcode !== 0x0 && opcode !== 0x1) return this.fail(`unknown opcode ${opcode}`)
      this.fragmentBytes += payload.length
      if (this.fragmentBytes > MAX_MESSAGE_BYTES) return this.fail('message too large', 1009)
      this.fragments.push(payload)
      if (fin) {
        const text = Buffer.concat(this.fragments).toString('utf8')
        this.fragments = []
        this.fragmentBytes = 0
        this.deliver(text)
      }
    }
  }
}

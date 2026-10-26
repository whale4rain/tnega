import type { Socket } from 'node:net'

/**
 * SOCKS5 握手（RFC 1928），只做 CONNECT 与「无认证」。读完握手后把多读的字节退回 socket，
 * 交还给调用方去接隧道。
 */

export const SOCKS_REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  notAllowed: 0x02,
  hostUnreachable: 0x04,
  commandNotSupported: 0x07,
  addressNotSupported: 0x08,
} as const

export interface SocksRequest {
  host: string
  port: number
}

/** 一个按需读取固定字节数的读者：握手结束后 `release()` 把剩余字节退回 socket。 */
class Reader {
  private buffer = Buffer.alloc(0)
  private waiting: { size: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void } | undefined
  private ended: Error | undefined

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData)
    socket.once('end', this.onEnd)
    socket.once('error', this.onEnd)
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.flush()
  }

  private readonly onEnd = (): void => {
    this.ended = new Error('client closed during the SOCKS handshake')
    this.waiting?.reject(this.ended)
    this.waiting = undefined
  }

  private flush(): void {
    if (this.waiting === undefined || this.buffer.length < this.waiting.size) return
    const { size, resolve } = this.waiting
    this.waiting = undefined
    const bytes = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    resolve(bytes)
  }

  read(size: number): Promise<Buffer> {
    if (this.ended) return Promise.reject(this.ended)
    return new Promise((resolve, reject) => {
      this.waiting = { size, resolve, reject }
      this.flush()
    })
  }

  release(): void {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('end', this.onEnd)
    this.socket.removeListener('error', this.onEnd)
    this.socket.pause()
    if (this.buffer.length > 0) this.socket.unshift(this.buffer)
  }
}

export class SocksError extends Error {
  constructor(message: string, readonly reply: number) {
    super(message)
  }
}

/** 发一个 SOCKS5 回复（绑定地址填 0.0.0.0:0）。 */
export function socksReply(socket: Socket, code: number): void {
  socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
}

function ipv6(bytes: Buffer): string {
  const groups: string[] = []
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16))
  return groups.join(':')
}

/**
 * 读 SOCKS5 的问候与请求。不支持的方法或命令会先回复对应的错误码再抛 {@link SocksError}。
 */
export async function readSocksRequest(socket: Socket): Promise<SocksRequest> {
  const reader = new Reader(socket)
  try {
    const [version = 0, count = 0] = await reader.read(2)
    if (version !== 0x05) throw new SocksError(`not a SOCKS5 client (version ${version})`, SOCKS_REPLY.generalFailure)
    const methods = await reader.read(count)
    if (!methods.includes(0x00)) {
      socket.end(Buffer.from([0x05, 0xff]))
      throw new SocksError('SOCKS client offers no unauthenticated method', SOCKS_REPLY.generalFailure)
    }
    socket.write(Buffer.from([0x05, 0x00]))
    const [, command = 0, , type = 0] = await reader.read(4)
    let host: string
    if (type === 0x01) host = [...await reader.read(4)].join('.')
    else if (type === 0x03) {
      const [length = 0] = await reader.read(1)
      host = (await reader.read(length)).toString('utf8')
    } else if (type === 0x04) host = ipv6(await reader.read(16))
    else throw new SocksError(`unsupported SOCKS address type ${type}`, SOCKS_REPLY.addressNotSupported)
    const port = (await reader.read(2)).readUInt16BE(0)
    if (command !== 0x01) throw new SocksError(`unsupported SOCKS command ${command}; only CONNECT is allowed`, SOCKS_REPLY.commandNotSupported)
    return { host, port }
  } finally {
    reader.release()
  }
}

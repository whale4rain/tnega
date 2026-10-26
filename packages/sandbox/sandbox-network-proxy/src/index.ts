/**
 * `@tnega/sandbox-network-proxy`：沙箱网络过滤代理，是 `@tnega/sandbox-local` 用的机制库。
 *
 * 受限命令被断掉直连（network namespace、Seatbelt、MXC 防火墙），唯一的出口是这个跑在宿主上
 * 的代理。它在同一个监听口上说 HTTP 代理（CONNECT 与绝对 URI 的明文请求）与 SOCKS5，对每个
 * 目标问一次 `decide`，放行的经用户的上游代理或直连出去。
 *
 * 和 `sandbox-windows-mxc` 一样，它是**机制库而不是缝的角色**：不依赖 `@tnega/sandbox`，
 * 判定规则由 Provider 以 `decide` 回调传进来。设计参考 Anthropic sandbox-runtime 的
 * `http-proxy.ts` / `socks-proxy.ts`。
 */

import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer, isIP, type AddressInfo, type Server, type Socket } from 'node:net'
import { dialDirect, isLocalAddress, LocalAddressError } from './dial.js'
import { readSocksRequest, SocksError, socksReply, SOCKS_REPLY } from './socks.js'
import { authority, bypassesUpstream, parseUpstreamProxy, tunnelThrough } from './upstream.js'

export { isLocalAddress, LocalAddressError } from './dial.js'
export { bypassesUpstream, parseUpstreamProxy } from './upstream.js'

/** 客户端想去的地方。 */
export interface ProxyTarget {
  /** 小写，IPv6 不带方括号。 */
  host: string
  port: number
}

/** `decide` 的结论。 */
export interface ProxyVerdict {
  allowed: boolean
  /** 判定原因的短码（会出现在事件与拒绝说明里）。 */
  reason: string
  /** 命中的规则原文。 */
  rule?: string
  /** 允许它的规则逐字点名了这个主机：只有这时，解析到本机地址的名字才放行。 */
  named?: boolean
}

export type ProxyProtocol = 'http' | 'connect' | 'socks5'

/** 每次判定（含解析之后的本机地址拦截）报告一次。 */
export interface ProxyDecision extends ProxyTarget {
  protocol: ProxyProtocol
  allowed: boolean
  reason: string
  rule?: string
  at: number
}

export interface NetworkProxyOptions {
  decide: (target: ProxyTarget) => ProxyVerdict
  /** 每次连接时读一次的上游代理 URL（`http://host:port`）；缺席或空串即直连。 */
  upstream?: () => string | undefined
  /** 每次连接时读一次的 `NO_PROXY`；命中的目标不走上游。 */
  noProxy?: () => string | undefined
  onDecision?: (decision: ProxyDecision) => void
  /** 替换 DNS（测试用）。 */
  resolve?: (host: string) => Promise<string[]>
  /** 被拦下时给客户端看的一句话；默认说明是哪个主机、为什么。 */
  explain?: (decision: ProxyDecision) => string
}

export type ProxyListen = { host: string; port: number } | { path: string }

export interface NetworkProxy {
  /** 实际监听的地址（端口 0 时由系统分配）。 */
  readonly address: { host: string; port: number } | { path: string }
  /** `since`（毫秒时间戳）之后被拦下的连接，最多保留最近 200 条。 */
  denialsSince(since: number): ProxyDecision[]
  close(): Promise<void>
}

const MAX_DENIALS = 200

function defaultExplain(decision: ProxyDecision): string {
  const target = authority(decision.host, decision.port)
  switch (decision.reason) {
    case 'local-address': return `tnega sandbox blocked ${target}: it resolves to a local address`
    case 'denied': return `tnega sandbox blocked ${target}: it matches the denied domain ${decision.rule ?? ''}`.trim()
    case 'network-off': return `tnega sandbox blocked ${target}: network access is off for commands`
    default: return `tnega sandbox blocked ${target}: it is not in the allowed domains`
  }
}

/** `host:port` 或 `[v6]:port`。 */
function parseAuthority(value: string | undefined): ProxyTarget | undefined {
  if (value === undefined) return undefined
  const match = /^\[([^\]]+)\]:(\d+)$/u.exec(value) ?? /^([^:]+):(\d+)$/u.exec(value)
  if (match === null) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return { host: (match[1] ?? '').toLowerCase(), port }
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer']

/** 启动过滤代理。 */
export async function startNetworkProxy(listen: ProxyListen, options: NetworkProxyOptions): Promise<NetworkProxy> {
  const sockets = new Set<Socket>()
  const denials: ProxyDecision[] = []
  const explain = options.explain ?? defaultExplain

  function record(target: ProxyTarget, protocol: ProxyProtocol, verdict: ProxyVerdict): ProxyDecision {
    const decision: ProxyDecision = {
      host: target.host,
      port: target.port,
      protocol,
      allowed: verdict.allowed,
      reason: verdict.reason,
      ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}),
      at: Date.now(),
    }
    if (!decision.allowed) {
      denials.push(decision)
      if (denials.length > MAX_DENIALS) denials.splice(0, denials.length - MAX_DENIALS)
    }
    try {
      options.onDecision?.(decision)
    } catch {
      // 观察者失败不影响判定。
    }
    return decision
  }

  function judge(target: ProxyTarget): ProxyVerdict {
    try {
      return options.decide(target)
    } catch {
      return { allowed: false, reason: 'decide-failed' }
    }
  }

  /** 这次连接要不要走上游代理；要的话返回解析好的上游。 */
  function upstreamFor(target: ProxyTarget): ReturnType<typeof parseUpstreamProxy> | undefined {
    const url = options.upstream?.()?.trim()
    if (!url || bypassesUpstream(target.host, options.noProxy?.())) return undefined
    return parseUpstreamProxy(url)
  }

  /**
   * 经上游出去时名字由上游解析，这里看不到答案；但字面量的本机地址与 `localhost` 不需要解析，
   * 规则没点名它时照样拦下 —— 否则一个通配规则就能借本机上的上游代理摸到宿主服务。
   */
  function localViaUpstream(target: ProxyTarget, protocol: ProxyProtocol, verdict: ProxyVerdict): ProxyDecision | undefined {
    if (verdict.named === true) return undefined
    const host = target.host
    const local = isIP(host) !== 0 ? isLocalAddress(host) : host === 'localhost' || host.endsWith('.localhost')
    if (!local) return undefined
    return record(target, protocol, { allowed: false, reason: 'local-address', ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}) })
  }

  /** 直连一个已放行的目标；名字解析到本机地址而规则没点名它时，记为拦下。 */
  async function dial(target: ProxyTarget, protocol: ProxyProtocol, verdict: ProxyVerdict): Promise<{ socket: Socket } | { denied: ProxyDecision }> {
    try {
      const socket = await dialDirect(target.host, target.port, {
        allowLocal: verdict.named === true,
        ...(options.resolve ? { resolve: options.resolve } : {}),
      })
      record(target, protocol, verdict)
      return { socket }
    } catch (error) {
      if (error instanceof LocalAddressError) {
        return { denied: record(target, protocol, { allowed: false, reason: 'local-address', ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}) }) }
      }
      throw error
    }
  }

  /** 判定并打通到目标的 TCP 隧道（CONNECT 与 SOCKS5）；被拒时返回拒绝的结论。 */
  async function open(target: ProxyTarget, protocol: ProxyProtocol): Promise<{ socket: Socket } | { denied: ProxyDecision }> {
    const verdict = judge(target)
    if (!verdict.allowed) return { denied: record(target, protocol, verdict) }
    const upstream = upstreamFor(target)
    if (upstream === undefined) return dial(target, protocol, verdict)
    const local = localViaUpstream(target, protocol, verdict)
    if (local !== undefined) return { denied: local }
    record(target, protocol, verdict)
    // 上游负责解析名字：本机地址检查只对直连有意义。
    return { socket: await tunnelThrough(upstream, target.host, target.port) }
  }

  function splice(client: Socket, remote: Socket): void {
    sockets.add(remote)
    remote.once('close', () => sockets.delete(remote))
    const closeBoth = (): void => {
      client.destroy()
      remote.destroy()
    }
    client.once('error', closeBoth)
    remote.once('error', closeBoth)
    client.once('close', () => remote.destroy())
    remote.once('close', () => client.destroy())
    remote.pipe(client)
    client.pipe(remote)
    client.resume()
    remote.resume()
  }

  async function onConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy())
    const target = parseAuthority(req.url)
    if (target === undefined) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    try {
      const opened = await open(target, 'connect')
      if ('denied' in opened) {
        const message = explain(opened.denied)
        client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nX-Tnega-Sandbox: blocked\r\nContent-Length: ${Buffer.byteLength(message) + 1}\r\nConnection: close\r\n\r\n${message}\n`)
        return
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) opened.socket.write(head)
      splice(client, opened.socket)
    } catch (error) {
      const message = `tnega sandbox could not reach ${authority(target.host, target.port)}: ${error instanceof Error ? error.message : String(error)}`
      client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message) + 1}\r\nConnection: close\r\n\r\n${message}\n`)
    }
  }

  function sendText(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...(status === 403 ? { 'x-tnega-sandbox': 'blocked' } : {}), connection: 'close' })
    res.end(`${message}\n`)
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      sendText(res, 400, 'tnega sandbox proxy: send an absolute http:// URL or use CONNECT')
      return
    }
    if (url.protocol !== 'http:') {
      sendText(res, 400, `tnega sandbox proxy: ${url.protocol}// requests must use CONNECT`)
      return
    }
    const target = { host: url.hostname.replace(/^\[|\]$/gu, '').toLowerCase(), port: url.port === '' ? 80 : Number(url.port) }
    // Host 跟着判定过的 URL 走：否则请求可以打到允许的主机、却选中它上面别的虚拟主机。
    const headers: IncomingHttpHeaders = { ...req.headers, host: url.host }
    for (const name of HOP_BY_HOP) delete headers[name]
    try {
      const verdict = judge(target)
      if (!verdict.allowed) {
        sendText(res, 403, explain(record(target, 'http', verdict)))
        return
      }
      const upstream = upstreamFor(target)
      let forward
      if (upstream !== undefined) {
        const local = localViaUpstream(target, 'http', verdict)
        if (local !== undefined) {
          sendText(res, 403, explain(local))
          return
        }
        // 明文请求按绝对 URI 交给上游：很多代理只允许 CONNECT 到 443。
        record(target, 'http', verdict)
        forward = httpRequest({
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: url.href,
          headers: { ...headers, ...(upstream.authorization ? { 'proxy-authorization': upstream.authorization } : {}) },
          agent: false,
        })
      } else {
        const opened = await dial(target, 'http', verdict)
        if ('denied' in opened) {
          sendText(res, 403, explain(opened.denied))
          return
        }
        // 走已经检查过地址的那条连接，不让请求再解析一次名字。
        forward = httpRequest({
          // No agent: with one, Node ignores createConnection and dials again.
          createConnection: () => opened.socket,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
        })
      }
      forward.once('response', (response) => {
        res.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers)
        response.pipe(res)
      })
      forward.once('error', error => sendText(res, 502, `tnega sandbox could not reach ${url.host}: ${error.message}`))
      req.pipe(forward)
    } catch (error) {
      sendText(res, 502, `tnega sandbox could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function onSocks(client: Socket): Promise<void> {
    let target: ProxyTarget
    try {
      const request = await readSocksRequest(client)
      target = { host: request.host.toLowerCase(), port: request.port }
    } catch (error) {
      if (error instanceof SocksError && !client.destroyed) socksReply(client, error.reply)
      client.end()
      return
    }
    try {
      const opened = await open(target, 'socks5')
      if ('denied' in opened) {
        socksReply(client, SOCKS_REPLY.notAllowed)
        client.end()
        return
      }
      socksReply(client, SOCKS_REPLY.succeeded)
      splice(client, opened.socket)
    } catch {
      socksReply(client, SOCKS_REPLY.hostUnreachable)
      client.end()
    }
  }

  const http = createHttpServer()
  http.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => { void onConnect(req, socket, head) })
  http.on('request', (req: IncomingMessage, res: ServerResponse) => { void onRequest(req, res) })
  http.on('clientError', (_error, socket: Socket) => socket.destroy())

  // 同一个口上分辨两种协议：SOCKS5 的第一个字节是版本号 5，HTTP 的第一个字节是方法名的字母。
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    // 只限制第一个字节之前的空等；之后由协议处理与两端自己决定空闲。
    socket.setTimeout(60_000, () => socket.destroy())
    socket.once('data', (chunk: Buffer) => {
      socket.pause()
      socket.unshift(chunk)
      socket.setTimeout(0)
      if (chunk[0] === 0x05) void onSocks(socket)
      else http.emit('connection', socket)
      socket.resume()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    const done = (): void => {
      server.removeListener('error', reject)
      resolve()
    }
    if ('path' in listen) server.listen(listen.path, done)
    else server.listen(listen.port, listen.host, done)
  })
  const bound = server.address()
  const address = typeof bound === 'string' || bound === null
    ? { path: 'path' in listen ? listen.path : String(bound) }
    : { host: (bound satisfies AddressInfo).address, port: bound.port }

  return {
    address,
    denialsSince: since => denials.filter(denial => denial.at >= since),
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.close(() => resolve())
    }),
  }
}

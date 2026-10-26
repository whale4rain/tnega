import { connect, isIP, type Socket } from 'node:net'

/**
 * 上游代理：用户自己的出口代理（例如 `http://127.0.0.1:7890`）。过滤代理放行一个目标之后，
 * 经它出去，而不是直连 —— 否则只能经代理上网的机器上，开了网络过滤反而什么都连不上。
 */
export interface UpstreamProxy {
  host: string
  port: number
  /** `Proxy-Authorization` 的值；URL 里没有用户名时缺席。 */
  authorization?: string
}

/**
 * 解析上游代理 URL。只支持 `http://`（CONNECT 与绝对 URI 转发）；其它协议抛错，绝不静默直连。
 * @throws Error 无法解析或协议不受支持。
 */
export function parseUpstreamProxy(url: string): UpstreamProxy {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error(`upstream proxy is not a URL: ${url}`)
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(`upstream proxy must be an http:// proxy; ${parsed.protocol}// is not supported: ${url}`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '')
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  const user = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)
  return {
    host,
    port,
    ...(user !== '' ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {}),
  }
}

/**
 * `NO_PROXY` 是否让 `host` 直连：`*` 全部直连；其余逐条按域名后缀（`.a.com` 与 `a.com` 等价）
 * 或 IP 精确匹配。端口与 CIDR 不支持（按字面比较不会命中，结果是走上游，而不是直连）。
 */
export function bypassesUpstream(host: string, noProxy: string | undefined): boolean {
  if (noProxy === undefined || noProxy.trim() === '') return false
  const target = host.toLowerCase()
  return noProxy.split(/[,\s]+/u).some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\*?\./u, '')
    if (entry === '') return false
    if (entry === '*') return true
    if (isIP(target) !== 0 || isIP(entry) !== 0) return target === entry
    return target === entry || target.endsWith(`.${entry}`)
  })
}

/** CONNECT 目标的写法：IPv6 要方括号。 */
export function authority(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`
}

/**
 * 经上游代理打通到 `host:port` 的隧道。成功时返回的 socket 已经越过了上游的响应头，
 * 后面就是目标的字节流。
 */
export function tunnelThrough(upstream: UpstreamProxy, host: string, port: number, timeoutMs = 30_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: upstream.host, port: upstream.port })
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error(`upstream proxy ${upstream.host}:${upstream.port} did not answer in ${timeoutMs} ms`)), timeoutMs)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.destroy()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > 64 * 1024) fail(new Error('upstream proxy sent an oversized response'))
        return
      }
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      const head = buffered.subarray(0, end).toString('latin1')
      const status = /^HTTP\/1\.[01] (\d{3})/u.exec(head)?.[1]
      if (status !== '200') {
        socket.destroy()
        reject(new Error(`upstream proxy refused ${authority(host, port)}: ${head.split('\r\n')[0] ?? 'no status line'}`))
        return
      }
      socket.pause()
      const rest = buffered.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
    socket.once('error', fail)
    socket.once('connect', () => {
      const target = authority(host, port)
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${
        upstream.authorization ? `Proxy-Authorization: ${upstream.authorization}\r\n` : ''}\r\n`)
    })
  })
}

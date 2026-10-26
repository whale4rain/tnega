import { lookup } from 'node:dns/promises'
import { connect, isIP, type Socket } from 'node:net'

/**
 * 地址是否指向**本机或本链路**：回环、未指定、链路本地（含云厂商的元数据地址
 * 169.254.169.254）、组播与广播。
 *
 * 这些地址从宿主上的代理连出去，等于让沙箱里的命令绕过 network namespace 摸到宿主的本地
 * 服务。私有网段（10/8、192.168/16……）不在这里：用户点名允许的内网域名，以及 fake-IP
 * 模式的代理（198.18/15）都依赖它们。
 */
export function isLocalAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isLocalV4(address)
  if (kind !== 6) return false
  // 先压缩成规范形态：SOCKS5 与 CONNECT 都可能送来展开的写法（0:0:0:0:0:0:0:1）。
  const value = canonicalV6(address)
  if (value === undefined) return true
  const mapped = mappedV4(value)
  if (mapped !== undefined) return isLocalV4(mapped)
  if (value === '::' || value === '::1') return true
  // fe80::/10 链路本地；ff00::/8 组播。
  return /^fe[89ab]/u.test(value) || value.startsWith('ff')
}

/** IPv6 的规范（压缩、小写）写法；读不懂就返回 `undefined`，调用方按本机处理（fail closed）。 */
function canonicalV6(address: string): string | undefined {
  try {
    return new URL(`http://[${address.replace(/%.*$/u, '')}]/`).hostname.slice(1, -1)
  } catch {
    return undefined
  }
}

/** `::ffff:a.b.c.d` 与 `::ffff:7f00:1` 两种写法的 IPv4 映射地址。 */
function mappedV4(value: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(value)?.[1]
  if (dotted !== undefined) return dotted
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value)
  if (hex === null) return undefined
  const high = Number.parseInt(hex[1] ?? '0', 16)
  const low = Number.parseInt(hex[2] ?? '0', 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

function isLocalV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224
}

/** 名字解析到了本机地址，而允许它的规则没有点名它。 */
export class LocalAddressError extends Error {
  override name = 'LocalAddressError'

  constructor(readonly host: string, readonly address: string) {
    super(`${host} resolves to ${address}, a local address; list ${host} itself (not a wildcard) to allow it`)
  }
}

export interface DialOptions {
  /** 允许连本机地址：允许它的规则逐字点名了这个主机。 */
  allowLocal: boolean
  /** 替换 DNS（测试用）。 */
  resolve?: (host: string) => Promise<string[]>
  timeoutMs?: number
}

export async function defaultResolve(host: string): Promise<string[]> {
  const answers = await lookup(host, { all: true, verbatim: true })
  return answers.map(answer => answer.address)
}

/**
 * 直连 `host:port`。先解析、按 {@link isLocalAddress} 检查**全部**答案，再连**已检查过**的
 * 地址 —— 而不是把名字交给 `connect` 再解析一次，否则 DNS 换答案（rebinding）就绕过了检查。
 * @throws LocalAddressError 任一答案是本机地址且 `allowLocal` 为假。
 */
export async function dialDirect(host: string, port: number, options: DialOptions): Promise<Socket> {
  const addresses = isIP(host) !== 0 ? [host] : await (options.resolve ?? defaultResolve)(host)
  if (addresses.length === 0) throw new Error(`${host} did not resolve to any address`)
  if (!options.allowLocal) {
    const local = addresses.find(isLocalAddress)
    if (local !== undefined) throw new LocalAddressError(host, local)
  }
  let lastError: unknown
  for (const address of addresses) {
    try {
      return await connectTo(address, port, options.timeoutMs ?? 30_000)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`cannot connect to ${host}:${port}`)
}

function connectTo(address: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`connecting to ${address}:${port} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
    const onError = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', onError)
  })
}

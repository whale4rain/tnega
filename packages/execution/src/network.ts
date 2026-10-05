import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Dispatcher, fetch as UndiciFetch } from 'undici'

// undici is loaded only when a proxy is in use: it is a runtime dependency of
// the package rather than part of every bundle, and a copied runtime without
// node_modules still works without a proxy.
type Undici = typeof import('undici')
let undici: Promise<Undici> | undefined
const loadUndici = (): Promise<Undici> => undici ??= import('undici')

/**
 * How the HTTP tools reach the network. Two things break them on real
 * machines, most visibly when installing a skill from GitHub:
 *
 * - **A proxy.** Node's fetch ignores the system proxy and the
 *   `HTTPS_PROXY` family, so where GitHub is only reachable through one the
 *   request times out or is reset.
 * - **DNS that answers with a reserved address.** Proxies in fake-IP mode
 *   (Clash and friends) answer every name with `198.18.x.x`, and polluted DNS
 *   answers `0.0.0.0`; the private-address guard then rejects the host.
 *
 * `proxy` (or the environment) routes requests through a proxy, and
 * `allowedHosts` lists hosts trusted whatever their DNS says.
 */
export interface NetworkPolicy {
  /** `host` or `*.domain` entries trusted even when DNS answers with a private or reserved address. */
  allowedHosts?: readonly string[]
  /** `http://host:port` proxy for the HTTP tools; absent uses `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`. */
  proxy?: string
  /** A fetch that already follows the system proxy (the desktop app passes Electron's). */
  fetch?: typeof globalThis.fetch
}

/** Where skills and code usually come from; trusted out of the box. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'github.com', '*.github.com', '*.githubusercontent.com',
  'gitlab.com', 'registry.npmjs.org', 'registry.npmmirror.com', 'pypi.org', 'files.pythonhosted.org',
]

let policy: NetworkPolicy = {}
let dispatcher: { key: string; value: Dispatcher } | undefined

/** Apply the System Config `network` settings (and the host's fetch) to later HTTP tool calls. */
export function configureNetwork(next: NetworkPolicy): void {
  policy = { ...next }
}

export function networkPolicy(): NetworkPolicy {
  return { ...policy }
}

/** Whether `host` matches an allowed entry: exact, or any subdomain of `*.domain`. */
export function isAllowedHost(host: string, entries: readonly string[] = [...DEFAULT_ALLOWED_HOSTS, ...(policy.allowedHosts ?? [])]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  return entries.some(raw => {
    const entry = raw.trim().toLowerCase()
    if (!entry) return false
    if (entry.startsWith('*.')) {
      const domain = entry.slice(2)
      return name === domain || name.endsWith(`.${domain}`)
    }
    return name === entry
  })
}

/** `HTTPS_PROXY` and friends, in curl's order of preference. */
function envProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

async function proxyDispatcher(): Promise<{ dispatcher: Dispatcher; fetch: typeof UndiciFetch } | undefined> {
  const configured = policy.proxy?.trim()
  const key = configured ? `proxy:${configured}` : envProxy() ? `env:${envProxy()}:${process.env.NO_PROXY ?? process.env.no_proxy ?? ''}` : undefined
  if (!key) return undefined
  const { EnvHttpProxyAgent, fetch, ProxyAgent } = await loadUndici()
  if (dispatcher?.key !== key) {
    void dispatcher?.value.close().catch(() => undefined)
    dispatcher = { key, value: configured ? new ProxyAgent(configured) : new EnvHttpProxyAgent() }
  }
  return { dispatcher: dispatcher.value, fetch }
}

/** Fetch through the configured proxy, the host's fetch, or directly. */
export async function networkFetch(url: URL, init: RequestInit): Promise<Response> {
  const viaProxy = await proxyDispatcher()
  try {
    if (viaProxy) {
      // undici's fetch with its own dispatcher; the Response it returns is web-compatible.
      const proxied: Parameters<typeof UndiciFetch>[1] = { dispatcher: viaProxy.dispatcher }
      if (init.redirect) proxied.redirect = init.redirect
      if (init.signal) proxied.signal = init.signal
      if (init.headers) proxied.headers = new Headers(init.headers)
      return await viaProxy.fetch(url, proxied) as unknown as Response
    }
    return await (policy.fetch ?? globalThis.fetch)(url, init)
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new Error(`could not reach ${url.host}: ${reason(error)}${viaProxy ? ' (through the configured proxy)' : '. If this site is only reachable through a proxy, set one in Settings → Tools & shell → Network'}`, { cause: error })
  }
}

function reason(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code
    const text = current.message + (typeof code === 'string' && !current.message.includes(code) ? ` (${code})` : '')
    if (text && !parts.some(part => part.includes(text))) parts.push(text)
    current = current.cause
  }
  return parts.join(': ') || String(error)
}

/**
 * Refuse destinations inside the private network unless the host is trusted.
 * The messages say which address the name resolved to and what to do, since
 * a proxy's fake-IP DNS makes a public site look private.
 */
export async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`unsupported protocol: ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`HTTP destination must be public: ${host || url.href} is a local name`)
  }
  if (!isIP(host) && isAllowedHost(host)) return
  let addresses: Array<{ address: string }>
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    throw new Error(`DNS lookup for ${host} failed${typeof code === 'string' ? ` (${code})` : ''}. Check the network connection, DNS or proxy settings.`, { cause: error })
  }
  const blocked = addresses.find(({ address }) => !isPublicAddress(address))
  if (!addresses.length || blocked) {
    const address = blocked?.address ?? 'no address'
    const fakeIp = blocked && /^198\.1[89]\./.test(blocked.address)
    throw new Error(`HTTP destination must be public: ${host} resolves to ${address}, a private or reserved address.${fakeIp ? ' This is how a proxy in fake-IP mode answers DNS.' : ''} If you trust ${host}, add it to Allowed hosts in Settings → Tools & shell → Network.`)
  }
}

export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const value = address.toLowerCase()
    if (value.startsWith('::ffff:') || value.startsWith('2002:')
      || value.startsWith('64:ff9b:')) return false
    return value !== '::1' && value !== '::' && !value.startsWith('fc')
      && !value.startsWith('fd') && !value.startsWith('fe8')
      && !value.startsWith('fe9') && !value.startsWith('fea') && !value.startsWith('feb')
      && !value.startsWith('ff') && !value.startsWith('2001:db8:')
  }
  const bytes = address.split('.').map(Number)
  if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return false
  const [a, b] = bytes
  return a !== 0 && a !== 10 && a !== 127 && a! < 224
    && !(a === 169 && b === 254) && !(a === 192 && (b === 168 || b === 0))
    && !(a === 100 && b! >= 64 && b! <= 127)
    && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 198 && (b === 18 || b === 19))
}

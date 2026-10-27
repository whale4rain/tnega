import { isIP } from 'node:net'
import { SandboxError } from './types.js'

/**
 * 受限命令的网络词汇：模式、域名规则的语法与判定。
 *
 * 这里只有纯函数，没有任何机制 —— 断网（network namespace、Seatbelt、MXC 防火墙）与
 * 过滤代理都属于 Provider。规则语法沿用 Anthropic sandbox-runtime 的子集，判定在这里只写
 * 一份，Provider 的代理与设置界面的校验共用它。
 */

/**
 * - `open`：不限制网络（默认，等同于本维度缺席）。
 * - `allowlist`：只能经过滤代理访问 `allowedDomains` 命中、且未被 `deniedDomains` 命中的目标。
 * - `off`：没有任何网络。
 */
export type SandboxNetworkMode = 'open' | 'allowlist' | 'off'

export const SANDBOX_NETWORK_MODES: readonly SandboxNetworkMode[] = ['open', 'allowlist', 'off']

export function isSandboxNetworkMode(value: unknown): value is SandboxNetworkMode {
  return typeof value === 'string' && (SANDBOX_NETWORK_MODES as readonly string[]).includes(value)
}

/** 一次受限执行的网络效果。只在 `allowlist` 下两张表才有意义；其它模式下它们被保留但不参与判定。 */
export interface SandboxNetworkPolicy {
  mode: SandboxNetworkMode
  /** 允许的目标：`example.com`、`*.example.com`（只含子域）、`*`、IP 字面量，可带 `:port`。 */
  allowedDomains: readonly string[]
  /** 拒绝的目标，同一语法；拒绝永远先于允许。 */
  deniedDomains: readonly string[]
}

/** `resolveNetworkPolicy` 的输入：都可省略。 */
export interface SandboxNetworkRequest {
  mode?: SandboxNetworkMode
  allowedDomains?: readonly string[]
  deniedDomains?: readonly string[]
}

export const OPEN_NETWORK: SandboxNetworkPolicy = Object.freeze({
  mode: 'open',
  allowedDomains: Object.freeze([]),
  deniedDomains: Object.freeze([]),
})

/** 一条解析后的规则。 */
export interface DomainPattern {
  /** 规范化后的主机（小写、去尾点、IPv6 去括号并压缩）；`any` 时为 `*`。 */
  host: string
  /** `exact` 只匹配主机本身；`subdomains` 只匹配子域（不含顶级本身）；`any` 匹配一切。 */
  match: 'exact' | 'subdomains' | 'any'
  port?: number
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u

function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false
  return value.split('.').every(label => LABEL.test(label))
}

function parsePort(text: string): number | undefined {
  if (!/^[1-9]\d{0,4}$/u.test(text)) return undefined
  const port = Number(text)
  return port <= 65_535 ? port : undefined
}

/** `:*`：把“不限端口”写明白；与省略端口同义。 */
function anyPort(text: string): boolean {
  return text === '*'
}

/** IPv6 的规范形态（与 URL 解析一致），以便规则与目标逐字比较。 */
function canonicalIpv6(address: string): string | undefined {
  if (isIP(address) !== 6) return undefined
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1)
  } catch {
    return undefined
  }
}

/**
 * 把目标主机规范化成可比较的键：小写、去掉尾点、IPv6 去括号并压缩。
 * @returns 非法主机返回 `undefined`。
 */
export function normalizeHost(host: string): string | undefined {
  let value = host.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (value.endsWith('.')) value = value.slice(0, -1)
  if (isIP(value) === 4) return value
  if (value.includes(':')) return canonicalIpv6(value)
  return isHostname(value) ? value : undefined
}

/**
 * 解析一条规则。语法：
 *
 * - `*`：任何目标；
 * - `example.com`：只有它本身，**不限端口**；
 * - `example.com:*`：同上，把「不限端口」写明白；
 * - `*.example.com`：只有它的子域（`a.example.com`、`a.b.example.com`），不含 `example.com`；
 * - IPv4 字面量，或带方括号的 IPv6 字面量（`[::1]`）；
 * - 以上任何一种后接 `:port`（1–65535），只匹配该端口。
 *
 * 「不带端口」等于「所有端口」：允许表里它是一条显式授权，拒绝表里它是一个兜底。
 * 只想要某个端口就写 `:443`，两种表都一样。
 *
 * @returns 非法规则返回 `undefined`（不猜测含义）。
 */
export function parseDomainPattern(entry: string): DomainPattern | undefined {
  const raw = entry.trim().toLowerCase()
  if (raw.length === 0 || /[\s/@?#]/u.test(raw)) return undefined
  let hostPart = raw
  let port: number | undefined
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    if (close < 0) return undefined
    const rest = raw.slice(close + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return undefined
      const written = rest.slice(1)
      if (!anyPort(written)) {
        port = parsePort(written)
        if (port === undefined) return undefined
      }
    }
    const host = canonicalIpv6(raw.slice(1, close))
    return host === undefined ? undefined : { host, match: 'exact', ...(port !== undefined ? { port } : {}) }
  }
  const colon = raw.lastIndexOf(':')
  if (colon >= 0) {
    // 不带括号的多冒号是 IPv6：不拆端口，让它按 IPv6 字面量被拒（必须带括号）。
    if (raw.indexOf(':') !== colon) return undefined
    const written = raw.slice(colon + 1)
    if (!anyPort(written)) {
      port = parsePort(written)
      if (port === undefined) return undefined
    }
    hostPart = raw.slice(0, colon)
  }
  const withPort = port !== undefined ? { port } : {}
  if (hostPart === '*') return { host: '*', match: 'any', ...withPort }
  if (hostPart.startsWith('*.')) {
    const domain = hostPart.slice(2).replace(/\.$/u, '')
    if (!isHostname(domain) || isIP(domain) !== 0) return undefined
    return { host: domain, match: 'subdomains', ...withPort }
  }
  const host = hostPart.replace(/\.$/u, '')
  if (isIP(host) === 4) return { host, match: 'exact', ...withPort }
  return isHostname(host) ? { host, match: 'exact', ...withPort } : undefined
}

/** 一条规则是否命中 `host:port`（`host` 须已 {@link normalizeHost}）。 */
export function matchesDomainPattern(pattern: DomainPattern, host: string, port: number): boolean {
  if (pattern.port !== undefined && pattern.port !== port) return false
  switch (pattern.match) {
    case 'any': return true
    case 'exact': return host === pattern.host
    case 'subdomains': return isIP(host) === 0 && host.endsWith(`.${pattern.host}`)
  }
}

/** 一张表里的非法规则，原样返回，供设置界面与配置解析指出是哪一条。 */
export function invalidDomainEntries(entries: readonly string[]): string[] {
  return entries.filter(entry => parseDomainPattern(entry) === undefined)
}

function normalizeList(entries: readonly string[] | undefined, field: string): string[] {
  if (entries === undefined) return []
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) {
    throw new SandboxError(`sandbox network ${field} must be an array of strings`, 'SANDBOX_INVALID_POLICY')
  }
  const cleaned = entries.map(entry => entry.trim()).filter(entry => entry.length > 0)
  const invalid = invalidDomainEntries(cleaned)
  if (invalid.length > 0) {
    throw new SandboxError(
      `sandbox network ${field} has entries that are not domains: ${invalid.map(entry => JSON.stringify(entry)).join(', ')}`,
      'SANDBOX_INVALID_POLICY',
    )
  }
  return [...new Set(cleaned.map(entry => entry.toLowerCase()))]
}

/**
 * 把网络请求解析成完全显式的策略：网络维度默认值唯一的落点。缺席即 `open`。
 * @throws SandboxError `SANDBOX_INVALID_POLICY`：未知模式或非法规则。
 */
export function resolveNetworkPolicy(request: SandboxNetworkRequest | undefined): SandboxNetworkPolicy {
  if (request === undefined) return OPEN_NETWORK
  const mode = request.mode ?? 'open'
  if (!isSandboxNetworkMode(mode)) {
    throw new SandboxError(`unknown sandbox network mode: ${JSON.stringify(request.mode)}`, 'SANDBOX_INVALID_POLICY')
  }
  return {
    mode,
    allowedDomains: normalizeList(request.allowedDomains, 'allowedDomains'),
    deniedDomains: normalizeList(request.deniedDomains, 'deniedDomains'),
  }
}

/** 运行期形状校验（事件改写之后用）。 */
export function isSandboxNetworkPolicy(value: unknown): value is SandboxNetworkPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const list = (entries: unknown): boolean => Array.isArray(entries)
    && entries.every(entry => typeof entry === 'string' && parseDomainPattern(entry) !== undefined)
  return isSandboxNetworkMode(Reflect.get(value, 'mode'))
    && list(Reflect.get(value, 'allowedDomains'))
    && list(Reflect.get(value, 'deniedDomains'))
}

/** 这份策略是否需要 Provider 限制网络。 */
export function isNetworkRestricted(policy: SandboxNetworkPolicy | undefined): boolean {
  return policy !== undefined && policy.mode !== 'open'
}

const STRICTNESS: Record<SandboxNetworkMode, number> = { open: 0, allowlist: 1, off: 2 }

/**
 * `after` 是否至少与 `before` 一样严格：`sandbox/pre-confine` 的监听器只能收紧。
 * 同为 `allowlist` 时，允许表只能变小（逐条字符串子集），拒绝表只能变大。
 */
export function isNetworkNarrowing(before: SandboxNetworkPolicy | undefined, after: SandboxNetworkPolicy | undefined): boolean {
  const from = before ?? OPEN_NETWORK
  const to = after ?? OPEN_NETWORK
  if (STRICTNESS[to.mode] !== STRICTNESS[from.mode]) return STRICTNESS[to.mode] > STRICTNESS[from.mode]
  if (to.mode !== 'allowlist') return true
  const allowed = new Set(from.allowedDomains.map(entry => entry.toLowerCase()))
  const denied = new Set(to.deniedDomains.map(entry => entry.toLowerCase()))
  return to.allowedDomains.every(entry => allowed.has(entry.toLowerCase()))
    && from.deniedDomains.every(entry => denied.has(entry.toLowerCase()))
}

/** 一次判定的结论。 */
export interface NetworkDecision {
  allowed: boolean
  /** 命中的规则（原文）；默认拒绝时缺席。 */
  rule?: string
  /**
   * - `open`：策略不限制网络；
   * - `allowed`：命中允许表；
   * - `denied`：命中拒绝表；
   * - `not-allowed`：两张表都没命中（默认拒绝）；
   * - `network-off`：策略关闭了网络；
   * - `invalid-host`：目标主机不是合法的域名或 IP。
   */
  reason: 'open' | 'allowed' | 'denied' | 'not-allowed' | 'network-off' | 'invalid-host'
  /**
   * 允许它的规则是否**逐字点名**了这个主机（而不是 `*` 或 `*.domain`）。代理据此决定
   * 一个解析到本机或链路本地地址的名字能否放行：只有被点名的才可以。
   */
  named: boolean
}

/**
 * 判定一次连接。顺序与 sandbox-runtime 一致：拒绝表 → 允许表 → 默认拒绝。
 */
export function decideNetworkAccess(policy: SandboxNetworkPolicy, host: string, port: number): NetworkDecision {
  if (policy.mode === 'open') return { allowed: true, reason: 'open', named: false }
  if (policy.mode === 'off') return { allowed: false, reason: 'network-off', named: false }
  const target = normalizeHost(host)
  if (target === undefined) return { allowed: false, reason: 'invalid-host', named: false }
  for (const entry of policy.deniedDomains) {
    const pattern = parseDomainPattern(entry)
    if (pattern !== undefined && matchesDomainPattern(pattern, target, port)) {
      return { allowed: false, rule: entry, reason: 'denied', named: pattern.match === 'exact' }
    }
  }
  let wildcard: NetworkDecision | undefined
  for (const entry of policy.allowedDomains) {
    const pattern = parseDomainPattern(entry)
    if (pattern === undefined || !matchesDomainPattern(pattern, target, port)) continue
    if (pattern.match === 'exact') return { allowed: true, rule: entry, reason: 'allowed', named: true }
    wildcard ??= { allowed: true, rule: entry, reason: 'allowed', named: false }
  }
  return wildcard ?? { allowed: false, reason: 'not-allowed', named: false }
}

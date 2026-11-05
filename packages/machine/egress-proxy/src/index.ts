import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { connect as tlsConnect, createSecureContext, TLSSocket, type SecureContext } from 'node:tls'
import { timingSafeEqual } from 'node:crypto'
import {
  startNetworkProxy,
  type NetworkProxy,
  type ProxyClient,
  type ProxyDecision,
  type ProxyListen,
  type ProxyTarget,
  type ProxyVerdict,
} from '@tnega/sandbox-network-proxy'
import { issueHostCertificate, type KeyPairPem } from './x509.js'

export { createRootCertificate, issueHostCertificate, type KeyPairPem } from './x509.js'

/**
 * `@tnega/egress-proxy`: the only way out of a box. Each box (and each phase of
 * a box: setup, agent) is a client with its own token and policy. The proxy
 * lets a client reach the hosts its policy names and, for the hosts that carry
 * a key, opens the TLS itself so it can add the key to each request. The box
 * never holds the key.
 *
 * Keys are added only to HTTPS requests whose CONNECT target and `Host` header
 * both name the key's exact host, on port 443, after the proxy has verified the
 * real host's certificate. A redirect to another host is a new CONNECT, which
 * carries that host's keys or none. Plain HTTP never carries a key.
 *
 * Built on `@tnega/sandbox-network-proxy`, so its rules hold here too: the host
 * is decided before any DNS lookup, and names that resolve to local or
 * cloud-metadata addresses are refused.
 */

/** One host's key: the headers the proxy sets (replacing any the box sent). */
export interface EgressCredential {
  host: string
  headers: Readonly<Record<string, string>>
}

export interface EgressPolicy {
  /** For logs and refusals: which box and phase this is. */
  name: string
  /** Hosts the client may reach: `example.com` or `*.example.com` (subdomains, not the apex). */
  allow: readonly string[]
  /** Hosts with keys; reaching them is allowed too. */
  credentials?: readonly EgressCredential[]
}

export interface EgressProxyOptions {
  /** The CA boxes trust for the hosts the proxy adds keys to. */
  root: KeyPairPem
  /** The policy for a client token, or undefined to refuse the client. Read on every connection, so a revoked token stops at once. */
  policy: (token: string) => EgressPolicy | undefined
  /** Upstream proxy for the proxy's own traffic (`http://host:port`). */
  upstream?: () => string | undefined
  noProxy?: () => string | undefined
  /** Extra CAs to trust when verifying real hosts (tests, private registries). Default: the system store. */
  trust?: readonly string[]
  onDecision?: (decision: ProxyDecision & { client?: string }) => void
  /** Replace DNS and the local address set (tests). */
  resolve?: (host: string) => Promise<string[]>
  localAddresses?: () => ReadonlySet<string>
  /** The port keys are added on. Only tests change it. */
  credentialPort?: number
}

export interface EgressProxy {
  readonly address: NetworkProxy['address']
  /** PEM of the CA certificate boxes must trust. */
  readonly caCertificate: string
  close(): Promise<void>
}

/** The token in `Proxy-Authorization: Basic base64(box:<token>)`. */
export function tokenFrom(client: ProxyClient): string | undefined {
  const header = client.proxyAuthorization
  if (!header?.startsWith('Basic ')) return undefined
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return undefined
  const token = decoded.slice(colon + 1)
  return token || undefined
}

/** Does `host` match one of the patterns? `*.x.com` matches subdomains at any depth, not `x.com` itself. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const lower = host.toLowerCase()
  return patterns.some(pattern => {
    const rule = pattern.toLowerCase()
    return rule.startsWith('*.') ? lower.endsWith(rule.slice(1)) && lower.length > rule.length - 1 : lower === rule
  })
}

function credentialFor(policy: EgressPolicy, host: string): EgressCredential | undefined {
  return policy.credentials?.find(credential => credential.host.toLowerCase() === host)
}

/** Constant-time lookup wrapper so a token's prefix cannot be found by timing. */
export function tokenPolicies(entries: ReadonlyArray<readonly [string, EgressPolicy]>): (token: string) => EgressPolicy | undefined {
  const list = entries.map(([token, policy]) => [Buffer.from(token, 'utf8'), policy] as const)
  return token => {
    const given = Buffer.from(token, 'utf8')
    let found: EgressPolicy | undefined
    for (const [known, policy] of list) {
      if (known.length === given.length && timingSafeEqual(known, given)) found = policy
    }
    return found
  }
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export async function startEgressProxy(listen: ProxyListen, options: EgressProxyOptions): Promise<EgressProxy> {
  const contexts = new Map<string, { context: SecureContext; until: number }>()
  const contextFor = (host: string): SecureContext => {
    const cached = contexts.get(host)
    if (cached && cached.until > Date.now()) return cached.context
    const leaf = issueHostCertificate(options.root, host)
    const context = createSecureContext({ cert: `${leaf.certificatePem}${options.root.certificatePem}`, key: leaf.keyPem })
    // Leaves live a week; mint a new one a day before.
    contexts.set(host, { context, until: Date.now() + 6 * 24 * 3_600_000 })
    return context
  }
  const policyOf = (client: ProxyClient): EgressPolicy | undefined => {
    const token = tokenFrom(client)
    if (!token) return undefined
    try {
      return options.policy(token)
    } catch {
      return undefined
    }
  }

  const decide = (target: ProxyTarget, client: ProxyClient): ProxyVerdict => {
    const policy = policyOf(client)
    if (!policy) return { allowed: false, reason: 'unknown-client' }
    // An exact name is "named" in the base proxy's sense: it may resolve to a private address.
    if (credentialFor(policy, target.host)) return { allowed: true, reason: 'credential', rule: target.host, named: true }
    if (hostAllowed(target.host, policy.allow)) return { allowed: true, reason: 'allowed', named: policy.allow.includes(target.host) }
    return { allowed: false, reason: 'not-allowed' }
  }

  /** Terminate the box's TLS for a host that carries a key, and forward each request with the key added. */
  const intercept = (target: ProxyTarget, client: ProxyClient) => {
    const policy = policyOf(client)
    const credential = policy && target.port === (options.credentialPort ?? 443) ? credentialFor(policy, target.host) : undefined
    if (!credential) return undefined
    return (socket: Socket, head: Buffer, dial: () => Promise<Socket>): void => {
      if (head.length > 0) socket.unshift(head)
      const secure = new TLSSocket(socket, { isServer: true, secureContext: contextFor(target.host), ALPNProtocols: ['http/1.1'] })
      secure.on('error', () => secure.destroy())
      const server = createHttpServer((req, res) => { void forward(req, res, target.host, credential, dial) })
      server.on('upgrade', (_req, upgraded: Socket) => upgraded.destroy())
      server.on('clientError', (_error, broken: Socket) => broken.destroy())
      server.emit('connection', secure)
    }
  }

  async function forward(req: IncomingMessage, res: ServerResponse, host: string, credential: EgressCredential, dial: () => Promise<Socket>): Promise<void> {
    const reply = (status: number, message: string): void => {
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      res.end(`${message}\n`)
    }
    // The key goes only to the host the tunnel was opened for.
    const named = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/u, '')
    if (named !== host) {
      reply(421, `tnega egress: this connection is for ${host}, not ${named || 'an unnamed host'}`)
      return
    }
    let upstream: TLSSocket
    try {
      const raw = await dial()
      upstream = await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tlsConnect({
          socket: raw,
          servername: host,
          ALPNProtocols: ['http/1.1'],
          ...(options.trust?.length ? { ca: [...options.trust] } : {}),
        })
        secure.once('secureConnect', () => resolve(secure))
        secure.once('error', reject)
      })
    } catch (error) {
      reply(502, `tnega egress could not reach ${host}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value
    for (const [name, value] of Object.entries(credential.headers)) headers[name.toLowerCase()] = value
    headers.host = host
    headers.connection = 'close'
    const out = httpRequest({ createConnection: () => upstream, method: req.method, path: req.url, headers })
    out.once('response', response => {
      const back: IncomingHttpHeaders = {}
      for (const [name, value] of Object.entries(response.headers)) if (!HOP_BY_HOP.has(name)) back[name] = value
      res.writeHead(response.statusCode ?? 502, response.statusMessage, back)
      response.pipe(res)
    })
    out.once('error', error => reply(502, `tnega egress could not reach ${host}: ${error.message}`))
    req.pipe(out)
  }

  const proxy = await startNetworkProxy(listen, {
    decide,
    intercept,
    ...(options.upstream ? { upstream: options.upstream } : {}),
    ...(options.noProxy ? { noProxy: options.noProxy } : {}),
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.localAddresses ? { localAddresses: options.localAddresses } : {}),
    ...(options.onDecision ? { onDecision: decision => options.onDecision?.(decision) } : {}),
    explain: decision => {
      const target = `${decision.host}:${decision.port}`
      switch (decision.reason) {
        case 'unknown-client': return `tnega egress refused ${target}: this box has no valid proxy token`
        case 'local-address': return `tnega egress refused ${target}: it resolves to a local address`
        default: return `tnega egress refused ${target}: it is not in this box's allowed hosts (.tnega/environment.toml [network] allow)`
      }
    },
  })
  return {
    address: proxy.address,
    caCertificate: options.root.certificatePem,
    close: () => proxy.close(),
  }
}

export const name = '@tnega/egress-proxy'

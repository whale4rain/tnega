import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/** Methods a route may claim; `*` claims every method (used by the API prefix). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*'

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void | Promise<void>

export type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void

export interface Route {
  /** `exact` compares the whole pathname; `prefix` claims everything below it. */
  kind: 'exact' | 'prefix'
  method: HttpMethod
  path: string
  handler: RouteHandler
}

export type RouteMatch =
  | { kind: 'route'; handler: RouteHandler }
  | { kind: 'method-not-allowed'; allow: readonly HttpMethod[] }
  | { kind: 'fallback'; handler: RouteHandler }
  | { kind: 'not-found' }

function routeKey(method: HttpMethod, path: string): string {
  return `${method}\0${path}`
}

/**
 * The host's routing table, shaped after dsh's `WebServer` service.
 *
 * It knows nothing about harness concepts and serves no files: features
 * register exact or prefix routes (and, later, upgrade routes) and the table
 * answers with one of four outcomes. Matching order is fixed — exact match,
 * then the longest prefix, then the single fallback seat — so registration
 * order never changes which handler runs.
 *
 * Registrations return a disposer so a feature can tie its routes to its own
 * Fiber; a duplicate path is a composition error and throws immediately.
 */
export class WebServerService {
  private readonly exact = new Map<string, RouteHandler>()
  private readonly prefixes = new Map<string, Route>()
  private readonly upgrades = new Map<string, UpgradeHandler>()
  private fallback: RouteHandler | undefined

  register(route: Route): () => void {
    if (!route.path.startsWith('/')) throw new Error(`route path must start with "/": ${route.path}`)
    const key = routeKey(route.method, route.path)
    if (route.kind === 'exact') {
      if (this.exact.has(key)) throw new Error(`route already registered: ${route.method} ${route.path}`)
      this.exact.set(key, route.handler)
      return () => {
        if (this.exact.get(key) === route.handler) this.exact.delete(key)
      }
    }
    if (this.prefixes.has(key)) throw new Error(`route already registered: ${route.method} ${route.path}`)
    this.prefixes.set(key, route)
    return () => {
      if (this.prefixes.get(key)?.handler === route.handler) this.prefixes.delete(key)
    }
  }

  /** Claim the one seat every unmatched request falls through to. */
  registerFallback(handler: RouteHandler): () => void {
    if (this.fallback) throw new Error('a fallback handler is already registered')
    this.fallback = handler
    return () => {
      if (this.fallback === handler) this.fallback = undefined
    }
  }

  /** Upgrade routes are exact-pathname only; the handler owns the handshake. */
  registerUpgrade(path: string, handler: UpgradeHandler): () => void {
    if (!path.startsWith('/')) throw new Error(`upgrade path must start with "/": ${path}`)
    if (this.upgrades.has(path)) throw new Error(`upgrade route already registered: ${path}`)
    this.upgrades.set(path, handler)
    return () => {
      if (this.upgrades.get(path) === handler) this.upgrades.delete(path)
    }
  }

  upgrade(pathname: string): UpgradeHandler | undefined {
    return this.upgrades.get(pathname)
  }

  match(method: string, pathname: string): RouteMatch {
    const upper = method.toUpperCase() as HttpMethod
    const exact = this.exact.get(routeKey(upper, pathname)) ?? this.exact.get(routeKey('*', pathname))
    if (exact) return { kind: 'route', handler: exact }

    let best: Route | undefined
    const allow = new Set<HttpMethod>()
    for (const entry of this.prefixes.values()) {
      if (!pathname.startsWith(entry.path)) continue
      if (entry.method === upper || entry.method === '*') {
        if (!best || entry.path.length > best.path.length) best = entry
      } else {
        allow.add(entry.method)
      }
    }
    if (best) return { kind: 'route', handler: best.handler }
    if (allow.size > 0) return { kind: 'method-not-allowed', allow: [...allow] }
    if (this.fallback) return { kind: 'fallback', handler: this.fallback }
    return { kind: 'not-found' }
  }
}

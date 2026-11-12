import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    webServer: WebServerService
  }
}

/** Methods a route may claim; `*` claims every method (used by the API prefix). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*'

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void | Promise<void>

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

/** Who sent a request, when a sign-in guard knows. */
export interface RequestPrincipal {
  accountId: string
  login: string
  role: string
}

/**
 * Facts a guard learned about one request, for the routes that run after it.
 * A feature adds what it needs here instead of each route asking it directly.
 */
export interface RequestAttributes {
  principal?: RequestPrincipal
  /** The sender may not turn the sandbox off (`bypass`) for a Session. */
  sandboxRequired?: boolean
}

/**
 * Runs before routing. Answer the request and resolve `true` to stop it there
 * (a sign-in check refusing it, say); resolve `false` to let routing go on.
 */
export type RequestGuard = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>

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
export class WebServerService extends Service {
  private readonly exact = new Map<string, RouteHandler>()
  private readonly prefixes = new Map<string, Route>()
  private readonly upgrades = new Map<string, UpgradeHandler>()
  private readonly guards: RequestGuard[] = []
  private readonly requestAttributes = new WeakMap<IncomingMessage, RequestAttributes>()
  private readonly registered: Array<() => void> = []
  private fallback: RouteHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'webServer')
    ctx.fiber.effect(() => () => {
      for (const dispose of this.registered.splice(0)) dispose()
    }, 'web server routes')
  }

  /** Bind a registration to this service's Fiber so unloading the host withdraws it. */
  private track(dispose: () => void): () => void {
    this.registered.push(dispose)
    return () => {
      const index = this.registered.indexOf(dispose)
      if (index >= 0) this.registered.splice(index, 1)
      dispose()
    }
  }

  register(route: Route): () => void {
    if (!route.path.startsWith('/')) throw new Error(`route path must start with "/": ${route.path}`)
    const key = routeKey(route.method, route.path)
    if (route.kind === 'exact') {
      if (this.exact.has(key)) throw new Error(`route already registered: ${route.method} ${route.path}`)
      this.exact.set(key, route.handler)
      return this.track(() => {
        if (this.exact.get(key) === route.handler) this.exact.delete(key)
      })
    }
    if (this.prefixes.has(key)) throw new Error(`route already registered: ${route.method} ${route.path}`)
    this.prefixes.set(key, route)
    return this.track(() => {
      if (this.prefixes.get(key)?.handler === route.handler) this.prefixes.delete(key)
    })
  }

  /** Claim the one seat every unmatched request falls through to. */
  registerFallback(handler: RouteHandler): () => void {
    if (this.fallback) throw new Error('a fallback handler is already registered')
    this.fallback = handler
    return this.track(() => {
      if (this.fallback === handler) this.fallback = undefined
    })
  }

  /** Upgrade routes are exact-pathname only; the handler owns the handshake. */
  registerUpgrade(path: string, handler: UpgradeHandler): () => void {
    if (!path.startsWith('/')) throw new Error(`upgrade path must start with "/": ${path}`)
    if (this.upgrades.has(path)) throw new Error(`upgrade route already registered: ${path}`)
    this.upgrades.set(path, handler)
    return this.track(() => {
      if (this.upgrades.get(path) === handler) this.upgrades.delete(path)
    })
  }

  /**
   * Add a check every request passes before routing, in registration order.
   * The host calls {@link guard}; a feature such as sign-in hooks in here
   * instead of the host knowing about it.
   */
  registerGuard(guard: RequestGuard): () => void {
    this.guards.push(guard)
    return this.track(() => {
      const index = this.guards.indexOf(guard)
      if (index >= 0) this.guards.splice(index, 1)
    })
  }

  /** Run the guards; `true` means one of them answered and routing must not run. */
  async guard(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    for (const guard of [...this.guards]) {
      if (await guard(req, res, url)) return true
    }
    return false
  }

  /** This request's attributes; guards write them, routes read them. */
  attributes(req: IncomingMessage): RequestAttributes {
    let found = this.requestAttributes.get(req)
    if (!found) this.requestAttributes.set(req, found = {})
    return found
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

/** Mounts the route table as `ctx.webServer`; features register their routes on it. */
export const webServer = {
  name: 'web-server',
  apply(ctx: Context): void {
    new WebServerService(ctx)
  },
}


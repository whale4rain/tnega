import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { WebServerService } from '../src/web-server.js'

const handler = (name: string) => () => { void name }

describe('web server route table', () => {
  it('matches an exact route before a prefix route', () => {
    const web = new WebServerService(new Context())
    const prefix = handler('prefix')
    const exact = handler('exact')
    web.register({ kind: 'prefix', method: 'GET', path: '/api/', handler: prefix })
    web.register({ kind: 'exact', method: 'GET', path: '/api/health', handler: exact })
    expect(web.match('GET', '/api/health')).toEqual({ kind: 'route', handler: exact })
    expect(web.match('GET', '/api/sessions')).toEqual({ kind: 'route', handler: prefix })
  })

  it('prefers the longest prefix regardless of registration order', () => {
    const web = new WebServerService(new Context())
    const api = handler('api')
    const sessions = handler('sessions')
    web.register({ kind: 'prefix', method: 'GET', path: '/api/sessions/', handler: sessions })
    web.register({ kind: 'prefix', method: 'GET', path: '/api/', handler: api })
    expect(web.match('GET', '/api/sessions/abc')).toEqual({ kind: 'route', handler: sessions })
    expect(web.match('GET', '/api/projects')).toEqual({ kind: 'route', handler: api })
  })

  it('treats the wildcard method as claiming every method', () => {
    const web = new WebServerService(new Context())
    const any = handler('any')
    web.register({ kind: 'prefix', method: '*', path: '/api/', handler: any })
    expect(web.match('POST', '/api/sessions')).toEqual({ kind: 'route', handler: any })
    expect(web.match('DELETE', '/api/x')).toEqual({ kind: 'route', handler: any })
  })

  it('reports a method mismatch when only other methods claim the path', () => {
    const web = new WebServerService(new Context())
    web.register({ kind: 'exact', method: 'GET', path: '/api/health', handler: handler('health') })
    // Exact lookups for other methods fall through to the prefix table; a
    // prefix route for another method is what produces 405.
    web.register({ kind: 'prefix', method: 'POST', path: '/api/', handler: handler('post') })
    expect(web.match('GET', '/api/other')).toEqual({ kind: 'method-not-allowed', allow: ['POST'] })
  })

  it('falls back once and refuses a second claimant', () => {
    const web = new WebServerService(new Context())
    const fallback = handler('static')
    const dispose = web.registerFallback(fallback)
    expect(web.match('GET', '/index.html')).toEqual({ kind: 'fallback', handler: fallback })
    expect(() => web.registerFallback(handler('other'))).toThrow(/fallback/)
    dispose()
    expect(web.match('GET', '/index.html')).toEqual({ kind: 'not-found' })
  })

  it('rejects duplicate paths and lets a disposer withdraw a route', () => {
    const web = new WebServerService(new Context())
    const first = handler('first')
    const dispose = web.register({ kind: 'exact', method: 'GET', path: '/api/health', handler: first })
    expect(() => web.register({ kind: 'exact', method: 'GET', path: '/api/health', handler: handler('second') }))
      .toThrow(/already registered/)
    dispose()
    expect(web.match('GET', '/api/health')).toEqual({ kind: 'not-found' })
  })

  it('registers exact upgrade routes and returns them by pathname', () => {
    const web = new WebServerService(new Context())
    const upgrade = () => {}
    const dispose = web.registerUpgrade('/api/remote.mux', upgrade)
    expect(web.upgrade('/api/remote.mux')).toBe(upgrade)
    expect(() => web.registerUpgrade('/api/remote.mux', upgrade)).toThrow(/already registered/)
    dispose()
    expect(web.upgrade('/api/remote.mux')).toBeUndefined()
  })

  it('requires absolute paths', () => {
    const web = new WebServerService(new Context())
    expect(() => web.register({ kind: 'exact', method: 'GET', path: 'api', handler: handler('x') }))
      .toThrow(/must start with/)
  })
})

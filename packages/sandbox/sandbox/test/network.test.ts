import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  OPEN_NETWORK,
  SandboxService,
  decideNetworkAccess,
  invalidDomainEntries,
  isNetworkNarrowing,
  normalizeHost,
  parseDomainPattern,
  resolveNetworkPolicy,
  resolveSandboxPolicy,
  type ConfinedArgv,
  type SandboxBackendStatus,
  type SandboxMechanismRequest,
  type SandboxNetworkEvent,
  type SandboxNetworkPolicy,
  type SandboxPreConfineEvent,
} from '../src/index.js'

const WORKSPACE = process.platform === 'win32' ? 'C:\\work' : '/work'

function allowlist(allowedDomains: string[], deniedDomains: string[] = []): SandboxNetworkPolicy {
  return resolveNetworkPolicy({ mode: 'allowlist', allowedDomains, deniedDomains })
}

describe('domain grammar', () => {
  it('parses exact names, subdomain wildcards, any, IPs and ports', () => {
    expect(parseDomainPattern('Example.COM.')).toEqual({ host: 'example.com', match: 'exact' })
    expect(parseDomainPattern('*.example.com')).toEqual({ host: 'example.com', match: 'subdomains' })
    expect(parseDomainPattern('*')).toEqual({ host: '*', match: 'any' })
    expect(parseDomainPattern('*:443')).toEqual({ host: '*', match: 'any', port: 443 })
    expect(parseDomainPattern('10.0.0.1:8080')).toEqual({ host: '10.0.0.1', match: 'exact', port: 8080 })
    expect(parseDomainPattern('[::1]:22')).toEqual({ host: '::1', match: 'exact', port: 22 })
    expect(parseDomainPattern('[0:0::1]')).toEqual({ host: '::1', match: 'exact' })
  })

  it('refuses entries it would have to guess about', () => {
    expect(invalidDomainEntries([
      '', 'http://example.com', 'example.com/path', 'user@example.com', '::1', 'example.com:0',
      'example.com:70000', '*.10.0.0.1', 'exa mple.com', '*example.com', '[::1', 'a..b',
    ])).toHaveLength(12)
  })

  it('normalises target hosts the same way as rules', () => {
    expect(normalizeHost('API.Example.com.')).toBe('api.example.com')
    expect(normalizeHost('[0:0:0:0:0:0:0:1]')).toBe('::1')
    expect(normalizeHost('fe80::1%eth0')).toBe('fe80::1')
    expect(normalizeHost('bad host')).toBeUndefined()
  })
})

describe('decideNetworkAccess', () => {
  it('denies before it allows, and denies anything unlisted', () => {
    const policy = allowlist(['*.example.com', 'example.com', 'pypi.org:443'], ['evil.example.com'])
    expect(decideNetworkAccess(policy, 'example.com', 443)).toMatchObject({ allowed: true, rule: 'example.com', named: true })
    expect(decideNetworkAccess(policy, 'a.b.example.com', 80)).toMatchObject({ allowed: true, rule: '*.example.com', named: false })
    expect(decideNetworkAccess(policy, 'EVIL.example.com', 443)).toMatchObject({ allowed: false, reason: 'denied', rule: 'evil.example.com' })
    expect(decideNetworkAccess(policy, 'pypi.org', 80)).toMatchObject({ allowed: false, reason: 'not-allowed' })
    expect(decideNetworkAccess(policy, 'notexample.com', 443)).toMatchObject({ allowed: false, reason: 'not-allowed' })
    expect(decideNetworkAccess(policy, 'bad host', 443)).toMatchObject({ allowed: false, reason: 'invalid-host' })
  })

  it('prefers a rule that names the host over a wildcard that also matches', () => {
    const policy = allowlist(['*', 'localhost'])
    expect(decideNetworkAccess(policy, 'localhost', 3000)).toMatchObject({ allowed: true, named: true, rule: 'localhost' })
    expect(decideNetworkAccess(policy, 'example.org', 443)).toMatchObject({ allowed: true, named: false, rule: '*' })
  })

  it('answers open and off without looking at the lists', () => {
    expect(decideNetworkAccess(OPEN_NETWORK, 'anything', 1)).toMatchObject({ allowed: true, reason: 'open' })
    const off = resolveNetworkPolicy({ mode: 'off', allowedDomains: ['*'] })
    expect(decideNetworkAccess(off, 'example.com', 443)).toMatchObject({ allowed: false, reason: 'network-off' })
  })
})

describe('resolveNetworkPolicy', () => {
  it('defaults to open and de-duplicates entries', () => {
    expect(resolveNetworkPolicy(undefined)).toEqual(OPEN_NETWORK)
    expect(resolveNetworkPolicy({})).toEqual({ mode: 'open', allowedDomains: [], deniedDomains: [] })
    expect(allowlist([' Example.com ', 'example.com', ''])).toMatchObject({ allowedDomains: ['example.com'] })
  })

  it('throws a policy error for an unknown mode or a bad entry', () => {
    expect(() => resolveNetworkPolicy({ mode: 'wide' as 'open' })).toThrow(/unknown sandbox network mode/)
    expect(() => allowlist(['http://x.com'])).toThrow(/not domains: "http:\/\/x.com"/)
  })

  it('is carried by resolveSandboxPolicy only when requested', () => {
    expect(resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: WORKSPACE })).not.toHaveProperty('network')
    expect(resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: WORKSPACE, network: { mode: 'off' } }).network)
      .toEqual({ mode: 'off', allowedDomains: [], deniedDomains: [] })
  })
})

describe('isNetworkNarrowing', () => {
  it('lets listeners only tighten', () => {
    const base = allowlist(['a.com', 'b.com'], ['x.com'])
    expect(isNetworkNarrowing(OPEN_NETWORK, base)).toBe(true)
    expect(isNetworkNarrowing(base, resolveNetworkPolicy({ mode: 'off' }))).toBe(true)
    expect(isNetworkNarrowing(base, allowlist(['a.com'], ['x.com', 'y.com']))).toBe(true)
    expect(isNetworkNarrowing(base, OPEN_NETWORK)).toBe(false)
    expect(isNetworkNarrowing(base, allowlist(['a.com', 'c.com'], ['x.com']))).toBe(false)
    expect(isNetworkNarrowing(base, allowlist(['a.com']))).toBe(false)
    expect(isNetworkNarrowing(undefined, undefined)).toBe(true)
  })
})

class NetworkStub extends SandboxService {
  readonly seen: SandboxMechanismRequest[] = []

  protected override runConfine(request: SandboxMechanismRequest): ConfinedArgv {
    this.seen.push(request)
    return { argv: ['/bin/true'], runner: 'stub', enforcement: 'full' }
  }

  override async status(): Promise<SandboxBackendStatus> {
    return { available: true, runner: 'stub', enforcement: 'full' }
  }

  report(event: SandboxNetworkEvent): Promise<void> {
    return this.reportNetwork(event)
  }
}

describe('SandboxService network surface', () => {
  const request = (network: SandboxNetworkPolicy) => ({
    op: 'shell' as const,
    argv: ['/bin/sh', '-c', 'true'],
    policy: { ...resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: WORKSPACE }), network },
  })

  it('hands the network policy to the provider and lets listeners narrow it', async () => {
    const root = new Context()
    const stub = new NetworkStub(root)
    root.on('sandbox/pre-confine', (event: SandboxPreConfineEvent, next: () => unknown) => {
      event.policy = { ...event.policy, network: allowlist(['a.com']) }
      return next()
    })

    await stub.confine(request(allowlist(['a.com', 'b.com'])))
    expect(stub.seen[0]?.policy.network).toEqual(allowlist(['a.com']))
  })

  it('fails closed when a listener widens the network', async () => {
    const root = new Context()
    const stub = new NetworkStub(root)
    root.on('sandbox/pre-confine', (event: SandboxPreConfineEvent, next: () => unknown) => {
      event.policy = { ...event.policy, network: OPEN_NETWORK }
      return next()
    })

    await expect(stub.confine(request(resolveNetworkPolicy({ mode: 'off' }))))
      .rejects.toMatchObject({ code: 'SANDBOX_INVALID_POLICY', message: expect.stringMatching(/widened the network/) })
    expect(stub.seen).toHaveLength(0)
  })

  it('reports proxy decisions as sandbox/network and ignores observer failures', async () => {
    const root = new Context()
    const stub = new NetworkStub(root)
    const seen: SandboxNetworkEvent[] = []
    root.on('sandbox/network', (event: SandboxNetworkEvent) => {
      seen.push(event)
    })
    root.on('sandbox/network', () => {
      throw new Error('observer broke')
    })
    const event: SandboxNetworkEvent = { host: 'evil.test', port: 443, protocol: 'connect', allowed: false, reason: 'not-allowed', at: 1 }

    await expect(stub.report(event)).resolves.toBeUndefined()
    expect(seen).toEqual([event])
  })
})

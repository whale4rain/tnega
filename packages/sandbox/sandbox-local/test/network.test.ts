import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { resolveNetworkPolicy, type SandboxNetworkRequest, type SandboxPolicy } from '@tnega/sandbox'
import { LocalSandboxService, type Config, type SandboxRunnerName } from '../src/index.js'
import { LINUX_PROXY_PORT, linuxRelayArgv, proxyEnvironment, seatbeltProfileArgs } from '../src/profiles.js'

const WS = process.platform === 'win32' ? 'C:\\work' : '/work'
const SHELL = ['/bin/sh', '-c', 'echo hi']
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function mount(runner: SandboxRunnerName, config: Config = {}, unsupported?: string): LocalSandboxService {
  const ctx = new Context()
  contexts.push(ctx)
  return new LocalSandboxService(ctx, {
    workspaceRoot: WS,
    upstreamProxy: () => '',
    internals: {
      platform: runner === 'seatbelt' ? 'darwin' : 'linux',
      chain: [runner],
      probe: () => 'full',
      networkProbe: () => unsupported,
    },
    ...config,
  })
}

function confine(service: LocalSandboxService, network: SandboxNetworkRequest) {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: WS, network: resolveNetworkPolicy(network) }
  return service.confine({ op: 'shell', argv: SHELL, policy })
}

describe.skipIf(process.platform === 'win32')('bwrap network', () => {
  it('gives an allowlisted command a private network, the proxy socket and a socat relay', async () => {
    const confined = await confine(mount('bwrap'), { mode: 'allowlist', allowedDomains: ['example.com'] })
    const argv = confined.argv
    const separator = argv.indexOf('--')
    const profile = argv.slice(0, separator)
    expect(profile).toContain('--unshare-net')
    const bound = profile[profile.lastIndexOf('--ro-bind') + 1] ?? ''
    expect(bound).toMatch(/tnega-net-/)
    expect(existsSync(bound)).toBe(true)
    const relay = argv.slice(separator + 1)
    expect(relay.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(relay[2]).toContain(`TCP6-LISTEN:${LINUX_PROXY_PORT}`)
    expect(relay[2]).toContain(`UNIX-CONNECT:${bound}/proxy.sock`)
    expect(relay.slice(3)).toEqual(['tnega-sandbox-net', ...SHELL])
    expect(confined.env).toMatchObject({ HTTPS_PROXY: `http://127.0.0.1:${LINUX_PROXY_PORT}`, NO_PROXY: 'localhost,127.0.0.1,::1' })
    expect(confined.annotate?.()).toBeUndefined()
  })

  it('cuts the network off without a proxy when the mode is off', async () => {
    const confined = await confine(mount('bwrap'), { mode: 'off' })
    expect(confined.argv).toContain('--unshare-net')
    expect(confined.argv.slice(confined.argv.indexOf('--') + 1)).toEqual(SHELL)
    expect(confined.env).toBeUndefined()
    expect(confined.annotate).toBeUndefined()
  })

  it('leaves an open network alone', async () => {
    const confined = await confine(mount('bwrap'), { mode: 'open' })
    expect(confined.argv).not.toContain('--unshare-net')
    expect(confined.env).toBeUndefined()
  })

  it('removes the proxy socket directory on dispose', async () => {
    const ctx = new Context()
    const service = new LocalSandboxService(ctx, {
      workspaceRoot: WS,
      upstreamProxy: () => '',
      internals: { platform: 'linux', chain: ['bwrap'], probe: () => 'full', networkProbe: () => undefined },
    })
    const confined = await confine(service, { mode: 'allowlist', allowedDomains: ['example.com'] })
    const relay = confined.argv[confined.argv.indexOf('--') + 3] ?? ''
    const socket = /UNIX-CONNECT:([^']+)/u.exec(relay)?.[1] ?? ''
    expect(existsSync(dirname(socket))).toBe(true)
    await ctx.fiber.dispose()
    expect(existsSync(dirname(socket))).toBe(false)
  })
})

describe('fail closed', () => {
  it.each(['landlock', 'custom'] as const)('refuses to run with open network when %s cannot filter', async (runner) => {
    const service = mount(runner, runner === 'custom'
      ? { runnerCommand: ['runner'], runnerFailureSignatures: ['runner: '] }
      : {}, `${runner} cannot restrict network access`)
    await expect(confine(service, { mode: 'off' })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      message: expect.stringMatching(/set to "off", but .* refusing to run the command with open network/),
    })
    await expect(confine(service, { mode: 'allowlist', allowedDomains: ['a.com'] })).rejects.toMatchObject({
      message: expect.stringMatching(/"listed domains only"/),
    })
  })

  it('still runs an open-network command on a mechanism that cannot filter', async () => {
    await expect(confine(mount('landlock', {}, 'nope'), { mode: 'open' })).resolves.toMatchObject({ runner: 'landlock' })
  })

  it('reports whether filtering works in status', async () => {
    expect((await mount('bwrap').status()).network).toEqual({ filtering: true })
    expect((await mount('landlock', {}, 'Landlock cannot').status()).network).toEqual({ filtering: false, detail: 'Landlock cannot' })
  })
})

describe('seatbelt network', () => {
  it('denies the network and allows only the proxy port on loopback', async () => {
    const confined = await confine(mount('seatbelt'), { mode: 'allowlist', allowedDomains: ['example.com'] })
    const profile = confined.argv[confined.argv.indexOf('-p') + 1] ?? ''
    const port = Number(/localhost:(\d+)/u.exec(profile)?.[1])
    expect(profile).toContain('(deny network*)')
    expect(port).toBeGreaterThan(0)
    expect(confined.env).toMatchObject({ HTTPS_PROXY: `http://127.0.0.1:${port}` })
    expect(confined.env?.GIT_SSH_COMMAND).toContain(`nc -X connect -x 127.0.0.1:${port}`)
  })

  it('denies everything when the mode is off', () => {
    const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: WS, network: resolveNetworkPolicy({ mode: 'off' }) })[1]
    expect(profile).toContain('(deny network*)')
    expect(profile).not.toContain('network-outbound')
  })
})

describe('proxy helpers', () => {
  it('quotes the socat path and socket inside the relay script', () => {
    const [, , script] = linuxRelayArgv("/opt/it's/socat", '/tmp/a b/proxy.sock')
    expect(script).toContain(`'/opt/it'\\''s/socat' TCP6-LISTEN`)
    expect(script).toContain(`'UNIX-CONNECT:/tmp/a b/proxy.sock'`)
  })

  it('routes git over ssh through the proxy on POSIX only', () => {
    expect(proxyEnvironment(3128, 'linux').GIT_SSH_COMMAND).toContain('socat - PROXY:127.0.0.1:%h:%p,proxyport=3128')
    expect(proxyEnvironment(3128, 'win32').GIT_SSH_COMMAND).toBeUndefined()
    expect(proxyEnvironment(8000, 'win32')).toMatchObject({ ALL_PROXY: 'http://127.0.0.1:8000', NODE_USE_ENV_PROXY: '1' })
  })
})

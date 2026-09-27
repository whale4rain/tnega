import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  SandboxService,
  SandboxUnavailableError,
  resolveSandboxPolicy,
  type ConfinedArgv,
  type SandboxBackendStatus,
  type SandboxConfineRequest,
  type SandboxConfinedEvent,
  type SandboxErrorEvent,
  type SandboxMechanismRequest,
  type SandboxPreConfineEvent,
} from '../src/index.js'

const WORKSPACE = process.platform === 'win32' ? 'C:\\work' : '/work'
const SHELL = process.platform === 'win32' ? ['cmd.exe', '/c', 'echo hi'] : ['/bin/sh', '-c', 'echo hi']

/**
 * 只回答固定 argv 的 Provider。它不 import、也不提及任何事件名：事件面在
 * `SandboxService.confine` 的模板方法上，Provider 只实现机制，因此自动参与全部事件。
 */
class StubSandbox extends SandboxService {
  readonly seen: SandboxMechanismRequest[] = []
  failure: Error | undefined
  result: ConfinedArgv = {
    argv: ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--', 'true'],
    runner: 'stub',
    enforcement: 'full',
    denialSignatures: ['read-only file system'],
    runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
  }

  protected override runConfine(request: SandboxMechanismRequest): ConfinedArgv {
    this.seen.push(request)
    if (this.failure) throw this.failure
    return this.result
  }

  override async status(): Promise<SandboxBackendStatus> {
    return { available: true, runner: 'stub', enforcement: 'full' }
  }
}

interface Harness {
  root: Context
  service: SandboxService
  stub: StubSandbox
}

/** 直接构造 Provider：它在基类构造时把自己注册成 `ctx.sandbox`。 */
function harness(): Harness {
  const root = new Context()
  const stub = new StubSandbox(root)
  return { root, service: stub, stub }
}

function request(overrides: Partial<SandboxConfineRequest> = {}): SandboxConfineRequest {
  return {
    op: 'shell',
    argv: SHELL,
    policy: resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: WORKSPACE }),
    ...overrides,
  }
}

describe('SandboxService.confine', () => {
  it('hands a fully explicit policy to the provider and returns its argv', async () => {
    const { service, stub } = harness()
    const confined = await service.confine(request())

    expect(confined.argv).toEqual(stub.result.argv)
    expect(stub.seen).toHaveLength(1)
    expect(stub.seen[0]).toMatchObject({ op: 'shell', argv: SHELL })
    expect(stub.seen[0]?.policy).toEqual({ mode: 'workspace-write', workspaceRoot: WORKSPACE })
  })

  it('dispatches sandbox/confined with the wrapping result for auditing', async () => {
    const { root, service } = harness()
    const events: SandboxConfinedEvent[] = []
    root.on('sandbox/confined', (event: SandboxConfinedEvent) => {
      events.push(event)
    })

    await service.confine(request())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      op: 'shell',
      argv: SHELL,
      confined: ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--', 'true'],
      runner: 'stub',
      enforcement: 'full',
    })
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('lets a listener narrow the policy and rewrite argv before the provider runs', async () => {
    const { root, service, stub } = harness()
    const before: string[] = []
    root.on('sandbox/pre-confine', (event: SandboxPreConfineEvent, next: () => unknown) => {
      before.push(event.policy.mode)
      event.policy = { ...event.policy, mode: 'read-only' }
      event.argv = ['/bin/echo', 'narrowed']
      return next()
    })

    await service.confine(request())

    expect(before).toEqual(['workspace-write'])
    expect(stub.seen[0]?.policy.mode).toBe('read-only')
    expect(stub.seen[0]?.argv).toEqual(['/bin/echo', 'narrowed'])
  })

  it('fails closed when a listener swallows the pre-confine event', async () => {
    const { root, service, stub } = harness()
    root.on('sandbox/pre-confine', () => undefined)

    await expect(service.confine(request()))
      .rejects.toMatchObject({ name: 'SandboxError', code: 'SANDBOX_INVALID_POLICY' })
    expect(stub.seen).toHaveLength(0)
  })

  it('fails closed when a listener widens the policy back to bypass', async () => {
    const { root, service, stub } = harness()
    root.on('sandbox/pre-confine', (event: SandboxPreConfineEvent, next: () => unknown) => {
      ;(event.policy as { mode: string }).mode = 'bypass'
      return next()
    })

    await expect(service.confine(request()))
      .rejects.toMatchObject({ code: 'SANDBOX_INVALID_POLICY' })
    expect(stub.seen).toHaveLength(0)
  })

  it('refuses to confine a bypass request at all', async () => {
    const { root, service, stub } = harness()
    let dispatched = 0
    root.on('sandbox/pre-confine', () => {
      dispatched += 1
    })

    await expect(service.confine(request({
      policy: resolveSandboxPolicy({ mode: 'bypass', workspaceRoot: WORKSPACE }),
    }))).rejects.toMatchObject({ code: 'SANDBOX_INVALID_POLICY' })
    expect(dispatched).toBe(0)
    expect(stub.seen).toHaveLength(0)
  })

  it('refuses a relative workspace root', async () => {
    const { service } = harness()
    await expect(service.confine(request({
      policy: { mode: 'workspace-write', workspaceRoot: 'work' },
    }))).rejects.toMatchObject({ code: 'SANDBOX_INVALID_POLICY' })
  })

  it('refuses an empty or non-string argv', async () => {
    const { service } = harness()
    await expect(service.confine(request({ argv: [] })))
      .rejects.toMatchObject({ code: 'SANDBOX_INVALID_ARGV' })
    await expect(service.confine(request({ argv: ['', 'x'] })))
      .rejects.toMatchObject({ code: 'SANDBOX_INVALID_ARGV' })
  })

  it('propagates an unavailable backend and reports it as a routable code', async () => {
    const { root, service, stub } = harness()
    stub.failure = new SandboxUnavailableError('workspace-write', 'bwrap missing')
    const errors: SandboxErrorEvent[] = []
    root.on('sandbox/error', (event: SandboxErrorEvent) => {
      errors.push(event)
    })

    await expect(service.confine(request()))
      .rejects.toMatchObject({ name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('SANDBOX_UNAVAILABLE')
    expect(errors[0]?.error.message).toContain('bwrap missing')
  })

  it('does not report a plain provider failure as a sandbox code', async () => {
    const { root, service, stub } = harness()
    stub.failure = new Error('runner exploded')
    const errors: SandboxErrorEvent[] = []
    root.on('sandbox/error', (event: SandboxErrorEvent) => {
      errors.push(event)
    })

    await expect(service.confine(request())).rejects.toThrowError('runner exploded')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBeUndefined()
  })

  it('keeps the authoritative result when an observer throws', async () => {
    const { root, service, stub } = harness()
    root.on('sandbox/confined', () => {
      throw new Error('observer is broken')
    })

    await expect(service.confine(request())).resolves.toEqual(stub.result)
  })

  it('rejects a provider result that is not a usable argv', async () => {
    const { service, stub } = harness()
    stub.result = { ...stub.result, argv: [] }
    await expect(service.confine(request()))
      .rejects.toMatchObject({ code: 'SANDBOX_INVALID_RESULT' })
  })

  it('unregisters its listeners when the registering fiber is disposed', async () => {
    const { root, service } = harness()
    let calls = 0
    const fiber = root.plugin((ctx) => {
      ctx.on('sandbox/confined', () => {
        calls += 1
      })
    })
    await fiber

    await service.confine(request())
    expect(calls).toBe(1)

    await fiber.dispose()
    await service.confine(request())
    expect(calls).toBe(1)
  })
})

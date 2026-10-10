import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  canonicalPath,
  SandboxError,
  SandboxUnavailableError,
  type SandboxPolicy,
} from '@tnega/sandbox'
import {
  LocalSandboxService,
  type Config,
  type SandboxRunnerName,
} from '../src/index.js'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.js'
import { __setWin32BindingsForTest } from '../../sandbox-windows-acl/src/ffi.js'
import { workspaceWriteSid } from '../../sandbox-windows-acl/src/workspace-sid.js'
import { createFakeWin32 } from '../../sandbox-windows-acl/test/support/fake-win32.js'

const WS = process.platform === 'win32' ? 'C:\\work' : '/work'
const SHELL = process.platform === 'win32'
  ? ['cmd.exe', '/d', '/s', '/c', 'echo hi']
  : ['/bin/sh', '-c', 'echo hi']

function policy(mode: 'read-only' | 'workspace-write', tempRoot?: string): SandboxPolicy {
  return {
    mode,
    workspaceRoot: WS,
    ...(tempRoot !== undefined ? { tempRoot } : {}),
  }
}

function mount(config: Config = {}): LocalSandboxService {
  const ctx = new Context()
  return new LocalSandboxService(ctx, {
    workspaceRoot: WS,
    internals: { platform: 'linux', chain: ['bwrap'], probe: () => 'full' },
    ...config,
  })
}

it('sets Node mode only for the Electron executable running the ACL runner', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  Object.defineProperty(process.versions, 'electron', { value: '44.4.3', configurable: true })
  try {
    const create = (command: string) => mount({
      windowsAclRunnerCommand: [command, 'runner.js'],
      internals: { platform: 'win32', chain: ['windows-acl'], probe: () => 'partial' },
    })
    const request = { op: 'shell' as const, argv: SHELL,
      policy: { ...policy('read-only'), workspaceRoot: process.cwd() },
    }
    expect((await create(process.execPath).confine(request)).env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    const builtin = mount({ internals: { platform: 'win32', chain: ['windows-acl'], probe: () => 'partial' } })
    expect((await builtin.confine(request)).env).toEqual({ ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' })
    expect((await create('node').confine(request)).env).toBeUndefined()
  } finally {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor)
    else Reflect.deleteProperty(process.versions, 'electron')
  }
})

it('shares one in-flight standing ACL grant between concurrent workspace-write commands', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'tnega-acl-ws-'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'tnega-acl-tmp-'))
  const fake = createFakeWin32()
  const sids: string[] = []
  __setWin32BindingsForTest({
    ...fake.bindings,
    convertStringSidToSidW: (sid, slot) => {
      sids.push(sid)
      return fake.bindings.convertStringSidToSidW(sid, slot)
    },
  })
  try {
    const service = mount({
      windowsAclRunnerCommand: ['node', 'runner.js'],
      internals: { platform: 'win32', chain: ['windows-acl'], probe: () => 'partial' },
    })
    const request = (sessionId: string) => ({ op: 'shell' as const, argv: SHELL,
      policy: { mode: 'workspace-write' as const, workspaceRoot: workspace, tempRoot, sessionId },
    })
    await Promise.all([service.confine(request('a')), service.confine(request('b')), service.confine(request('c'))])
    await service.confine(request('d'))
    const workspaceSid = workspaceWriteSid(canonicalPath(workspace))
    expect(sids.filter(sid => sid === workspaceSid)).toHaveLength(1)
  } finally {
    __setWin32BindingsForTest(undefined)
    rmSync(workspace, { recursive: true, force: true })
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

async function confinedArgv(
  service: LocalSandboxService,
  mode: 'read-only' | 'workspace-write' = 'workspace-write',
  tempRoot?: string,
): Promise<string[]> {
  const confined = await service.confine({ op: 'shell', argv: SHELL, policy: policy(mode, tempRoot) })
  return confined.argv
}

describe('bwrap', () => {
  it('binds the whole tree read-only and only the workspace writable', async () => {
    expect(await confinedArgv(mount())).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--tmpfs', '/tmp',
      '--bind', WS, WS,
      '--',
      ...SHELL,
    ])
  })

  it('leaves read-only with no writable mount at all', async () => {
    const argv = await confinedArgv(mount(), 'read-only')
    expect(argv).not.toContain('--bind')
    expect(argv).not.toContain('--tmpfs')
    expect(argv).toEqual(['bwrap', ...bwrapProfileArgs(policy('read-only')), '--', ...SHELL])
  })

  it('reports its own denial dialect and runner failure signature', async () => {
    const confined = await mount().confine({ op: 'shell', argv: SHELL, policy: policy('read-only') })
    expect(confined.runner).toBe('bwrap')
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toContain('read-only file system')
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['bwrap: '] }])
  })
})

describe('landlock', () => {
  it('grants only /dev/null as a file sink and keeps the real /tmp in workspace-write', async () => {
    const service = mount({
      internals: { platform: 'linux', chain: ['landlock'], probe: () => 'full' },
      landlockLauncher: '/opt/landlock-run',
    })
    expect(await confinedArgv(service)).toEqual([
      '/opt/landlock-run',
      ...landlockProfileArgs(policy('workspace-write')),
      '--',
      ...SHELL,
    ])
  })

  it('reports partial enforcement when the launcher negotiated an older ABI', async () => {
    const service = mount({
      internals: { platform: 'linux', chain: ['landlock'], probe: () => 'partial' },
    })
    const confined = await service.confine({ op: 'shell', argv: SHELL, policy: policy('workspace-write') })
    expect(confined.enforcement).toBe('partial')
    expect(confined.runnerFailureRules).toEqual([
      { allowedExitCodes: [125], fatalSignatures: ['landlock-run: '] },
    ])
  })
})

describe('seatbelt', () => {
  it('denies every write and then allows the shared writable roots', async () => {
    const service = mount({ internals: { platform: 'darwin', chain: ['seatbelt'], probe: () => 'full' } })
    const argv = await confinedArgv(service)
    expect(argv[0]).toBe('sandbox-exec')
    expect(argv[1]).toBe('-p')
    expect(argv[3]).toBe('--')
    const profile = argv[2] ?? ''
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(literal "/dev/null")')
    expect(profile).toContain('(subpath ')
  })
})

describe('mechanism selection', () => {
  it('falls back along the chain when a mechanism fails its functional probe', async () => {
    const probed: SandboxRunnerName[] = []
    const service = mount({
      internals: {
        platform: 'linux',
        chain: ['bwrap', 'landlock'],
        probe: (runner) => {
          probed.push(runner)
          return runner === 'bwrap' ? 'unusable' : 'full'
        },
      },
    })

    const confined = await service.confine({ op: 'shell', argv: SHELL, policy: policy('read-only') })
    expect(confined.runner).toBe('landlock')
    expect(probed).toEqual(['bwrap', 'landlock'])
  })

  it('caches the probe verdict for the provider lifetime', async () => {
    let probes = 0
    const service = mount({
      internals: {
        platform: 'linux',
        chain: ['bwrap'],
        probe: () => {
          probes += 1
          return 'full'
        },
      },
    })

    await service.confine({ op: 'shell', argv: SHELL, policy: policy('read-only') })
    await service.confine({ op: 'shell', argv: SHELL, policy: policy('workspace-write') })
    expect(probes).toBe(1)
  })

  it('fails closed with a routable code when no mechanism is usable', async () => {
    const service = mount({
      internals: { platform: 'linux', chain: ['bwrap'], probe: () => 'unusable' },
    })

    await expect(service.confine({ op: 'shell', argv: SHELL, policy: policy('read-only') }))
      .rejects.toMatchObject({ name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' })
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.detail).toContain('bwrap')
  })

  it('has no chain for an unsupported platform', async () => {
    const service = mount({ internals: { platform: 'aix', chain: [] } })
    expect(await service.status()).toMatchObject({ available: false })
    await expect(service.confine({ op: 'shell', argv: SHELL, policy: policy('read-only') }))
      .rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('reports the Windows ACL mechanism as partial without pretending it is full', async () => {
    const service = mount({
      internals: { platform: 'win32', chain: ['windows-acl'], probe: () => 'partial' },
    })
    expect(await service.status()).toEqual({
      available: true,
      runner: 'windows-acl',
      enforcement: 'partial',
    })
  })
})

describe('provider invariants', () => {
  it('refuses a private temp root inside the workspace', async () => {
    const inside = process.platform === 'win32' ? `${WS}\\tmp` : `${WS}/tmp`
    await expect(confinedArgv(mount(), 'workspace-write', inside))
      .rejects.toMatchObject({ name: 'SandboxError', code: 'SANDBOX_INVALID_POLICY' })
  })

  it('rejects a probe timeout that Node would read as "no timeout"', () => {
    expect(() => mount({ probeTimeoutMs: 0 })).toThrowError(TypeError)
    expect(() => mount({ probeTimeoutMs: Number.POSITIVE_INFINITY })).toThrowError(TypeError)
  })

  it('requires a custom runner to declare its failure signatures', () => {
    expect(() => mount({ runnerCommand: ['my-runner'] })).toThrowError(TypeError)
    expect(() => mount({ runnerFailureSignatures: ['my-runner: '] })).toThrowError(TypeError)
    expect(() => mount({ runnerCommand: ['my-runner'], runnerFailureSignatures: ['  '] }))
      .toThrowError(TypeError)
  })
})

describe('custom runner', () => {
  it('passes the fully explicit policy to a runner the deployment provides', async () => {
    const service = mount({
      internals: { platform: 'linux', chain: ['custom'], probe: () => 'full' },
      runnerCommand: ['my-runner', '--strict'],
      runnerFailureSignatures: ['my-runner: '],
    })

    const confined = await service.confine({
      op: 'process',
      argv: ['rg', '--json', 'x'],
      policy: policy('workspace-write'),
    })

    expect(confined.argv).toEqual([
      'my-runner', '--strict',
      '--mode', 'workspace-write',
      '--workspace', WS,
      '--temp', confined.argv[confined.argv.indexOf('--temp') + 1],
      '--',
      'rg', '--json', 'x',
    ])
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['my-runner: '] }])
    expect(confined.denialSignatures).toEqual([])
  })

  it('is unusable when no runner command is configured', async () => {
    const service = mount({ internals: { platform: 'linux', chain: ['custom'] } })
    expect(await service.status()).toMatchObject({ available: false })
  })
})

describe('profile args', () => {
  it('keeps read-only profiles free of writable grants', () => {
    expect(landlockProfileArgs(policy('read-only'))).toEqual(['--ro', '/', '--rw', '/dev/null'])
    expect(seatbeltProfileArgs(policy('read-only')).join(' ')).not.toContain('(subpath ')
  })

  it('escapes seatbelt strings instead of interpolating raw paths', () => {
    const odd: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/work/with"quote' }
    const profile = seatbeltProfileArgs(odd).join(' ')
    expect(profile).toContain('(subpath "/work/with\\"quote")')
  })

  it('is a pure function of the policy', () => {
    const before = bwrapProfileArgs(policy('workspace-write'))
    const after = bwrapProfileArgs(policy('workspace-write'))
    expect(after).toEqual(before)
  })
})

describe('error surface', () => {
  it('reports a sandbox policy violation with the sandbox code, not a bare Error', async () => {
    const failure = await confinedArgv(mount(), 'workspace-write', `${WS}/tmp`)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SandboxError)
    expect((failure as SandboxError).code).toBe('SANDBOX_INVALID_POLICY')
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { BackgroundProcessRequest, ExecutionProvider, ProcessRequest, ShellRequest } from '@tnega/execution'
import {
  SandboxService,
  SandboxUnavailableError,
  resolveSandboxPolicy,
  type ConfinedArgv,
  type SandboxBackendStatus,
  type SandboxConfineRequest,
  type SandboxMechanismRequest,
} from '@tnega/sandbox'
import { sandboxedExecution } from '../src/index.js'

const WORKSPACE = process.platform === 'win32' ? 'C:\\work' : '/work'

/** 记录被包装的 argv，并交回一个可识别的受限 argv。 */
class RecordingSandbox extends SandboxService {
  readonly requests: SandboxConfineRequest[] = []
  unavailable = false
  runnerEnv?: Readonly<Record<string, string>>

  protected override runConfine(request: SandboxMechanismRequest): ConfinedArgv {
    this.requests.push({
      op: request.op,
      argv: request.argv,
      policy: request.policy,
    })
    if (this.unavailable) throw new SandboxUnavailableError('workspace-write', 'no backend')
    return {
      argv: ['RUNNER', '--', ...request.argv],
      ...(this.runnerEnv ? { env: this.runnerEnv } : {}),
      runner: 'recording',
      enforcement: 'full',
      denialSignatures: ['denied'],
      runnerFailureRules: [],
    }
  }

  override async status(): Promise<SandboxBackendStatus> {
    return { available: !this.unavailable, runner: 'recording', enforcement: 'full' }
  }
}

class RecordingExecution implements ExecutionProvider {
  readonly shells: ShellRequest[] = []
  readonly processes: ProcessRequest[] = []

  async runShell(request: ShellRequest) {
    this.shells.push(request)
    return { exitCode: 0, stdout: 'direct', stderr: '' }
  }

  async runProcess(request: ProcessRequest) {
    this.processes.push(request)
    return { exitCode: 0, stdout: 'wrapped', stderr: '', stdoutTruncated: false }
  }

  async fetchHttp() {
    return { status: 200, ok: true, headers: {}, body: 'ok', truncated: false }
  }
}

function mount(): { ctx: Context; sandbox: RecordingSandbox; inner: RecordingExecution } {
  const ctx = new Context()
  const sandbox = new RecordingSandbox(ctx)
  const inner = new RecordingExecution()
  return { ctx, sandbox, inner }
}

function execution(
  ctx: Context,
  inner: ExecutionProvider,
  mode: 'read-only' | 'workspace-write' | 'bypass' = 'workspace-write',
  extra: { confineProcess?: boolean } = {},
) {
  return sandboxedExecution(ctx, {
    inner,
    policy: resolveSandboxPolicy({ mode, workspaceRoot: WORKSPACE }),
    ...extra,
  })
}

describe('sandboxed execution', () => {
  it('passes runner environment to shell and argv execution with runner precedence', async () => {
    const { ctx, sandbox, inner } = mount()
    sandbox.runnerEnv = { ELECTRON_RUN_AS_NODE: '1' }
    const provider = execution(ctx, inner)
    await provider.runShell({ command: 'echo hi', cwd: WORKSPACE })
    await provider.runProcess({ argv: ['node', '-e', '0'], cwd: WORKSPACE,
      env: { ELECTRON_RUN_AS_NODE: '0', CHILD_VALUE: 'kept' },
    })
    expect(inner.processes[0]?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(inner.processes[1]?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CHILD_VALUE: 'kept' })
  })
  it('turns a shell command into an explicit argv before it reaches the provider', async () => {
    const { ctx, sandbox, inner } = mount()
    const result = await execution(ctx, inner).runShell({
      command: 'echo hi | wc -l',
      cwd: WORKSPACE,
      timeoutMs: 1_000,
    })

    expect(result).toEqual({ exitCode: 0, stdout: 'wrapped', stderr: '' })
    const expectedShell = process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', 'echo hi | wc -l']
      : ['/bin/sh', '-c', 'echo hi | wc -l']
    expect(sandbox.requests[0]).toMatchObject({ op: 'shell', argv: expectedShell })
    expect(inner.processes[0]?.argv).toEqual(['RUNNER', '--', ...expectedShell])
    expect(inner.processes[0]?.cwd).toBe(WORKSPACE)
    expect(inner.processes[0]?.timeoutMs).toBe(1_000)
    expect(inner.shells).toHaveLength(0)
  })

  it('confines shell-free argv processes too', async () => {
    const { ctx, sandbox, inner } = mount()
    await execution(ctx, inner).runProcess({ argv: ['rg', '--json', 'x'], cwd: WORKSPACE })

    expect(sandbox.requests[0]).toMatchObject({ op: 'process', argv: ['rg', '--json', 'x'] })
    expect(inner.processes[0]?.argv).toEqual(['RUNNER', '--', 'rg', '--json', 'x'])
  })

  it('can leave argv processes unconfined when the deployment asks for it', async () => {
    const { ctx, sandbox, inner } = mount()
    await execution(ctx, inner, 'workspace-write', { confineProcess: false })
      .runProcess({ argv: ['rg', 'x'], cwd: WORKSPACE })

    expect(sandbox.requests).toHaveLength(0)
    expect(inner.processes[0]?.argv).toEqual(['rg', 'x'])
  })

  it('passes bypass straight through: that is the explicit "no sandbox" choice', async () => {
    const { ctx, sandbox, inner } = mount()
    const provider = execution(ctx, inner, 'bypass')

    const shell = await provider.runShell({ command: 'echo hi', cwd: WORKSPACE })
    expect(shell.stdout).toBe('direct')
    expect(sandbox.requests).toHaveLength(0)
    expect(inner.shells).toHaveLength(1)
  })

  it('resolves the policy for each execution instead of keeping the startup mode', async () => {
    const { ctx, sandbox, inner } = mount()
    let mode: 'read-only' | 'workspace-write' | 'bypass' = 'read-only'
    const provider = sandboxedExecution(ctx, {
      inner,
      policy: resolveSandboxPolicy({ mode, workspaceRoot: WORKSPACE }),
      resolvePolicy: () => resolveSandboxPolicy({ mode, workspaceRoot: WORKSPACE }),
    })

    await provider.runShell({ command: 'echo confined', cwd: WORKSPACE })
    mode = 'bypass'
    await provider.runShell({ command: 'echo direct', cwd: WORKSPACE })

    expect(sandbox.requests).toHaveLength(1)
    expect(inner.shells).toEqual([{ command: 'echo direct', cwd: WORKSPACE }])
  })

  it('never falls back to an unconfined run when no backend is usable', async () => {
    const { ctx, sandbox, inner } = mount()
    sandbox.unavailable = true

    await expect(execution(ctx, inner).runShell({ command: 'echo hi', cwd: WORKSPACE }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(inner.shells).toHaveLength(0)
    expect(inner.processes).toHaveLength(0)
  })

  it('fails loudly when no provider is mounted at all', async () => {
    const inner = new RecordingExecution()
    await expect(execution(new Context(), inner).runShell({ command: 'echo hi', cwd: WORKSPACE }))
      .rejects.toThrowError(/requires a mounted sandbox provider/)
    expect(inner.shells).toHaveLength(0)
  })

  it('leaves network access alone: no backend restricts it, so the vocabulary does not claim to', async () => {
    const { ctx, inner } = mount()
    const response = await execution(ctx, inner).fetchHttp({ url: 'https://example.com' })
    expect(response.body).toBe('ok')
  })
})

describe('sandboxed background processes', () => {
  class BackgroundExecution extends RecordingExecution {
    readonly started: BackgroundProcessRequest[] = []

    async startProcess(request: BackgroundProcessRequest) {
      this.started.push(request)
      return {
        pid: 1,
        output: () => '',
        exitCode: () => undefined,
        exited: new Promise<number | null>(() => {}),
        kill: async () => {},
      }
    }
  }

  it('confines a background shell command like a foreground one', async () => {
    const { ctx, sandbox } = mount()
    const inner = new BackgroundExecution()
    await execution(ctx, inner).startShell!({ command: 'npm run dev', cwd: WORKSPACE })
    expect(sandbox.requests[0]?.op).toBe('shell')
    expect(inner.started[0]?.argv[0]).toBe('RUNNER')
    expect(inner.started[0]?.argv.at(-1)).toBe('npm run dev')
  })

  it('preserves runner environment for both background execution paths', async () => {
    const { ctx, sandbox } = mount()
    sandbox.runnerEnv = { ELECTRON_RUN_AS_NODE: '1' }
    const inner = new BackgroundExecution()
    const provider = execution(ctx, inner)
    await provider.startShell!({ command: 'echo hi', cwd: WORKSPACE })
    await provider.startProcess!({ argv: ['node'], cwd: WORKSPACE, env: { CHILD_VALUE: 'kept' } })
    expect(inner.started[0]?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(inner.started[1]?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CHILD_VALUE: 'kept' })
  })

  it('starts nothing when no backend is usable', async () => {
    const { ctx, sandbox } = mount()
    sandbox.unavailable = true
    const inner = new BackgroundExecution()
    await expect(execution(ctx, inner).startShell!({ command: 'npm run dev', cwd: WORKSPACE }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(inner.started).toHaveLength(0)
  })

  it('offers no background start when the inner boundary cannot', () => {
    const { ctx, inner } = mount()
    expect(execution(ctx, inner).startShell).toBeUndefined()
  })
})

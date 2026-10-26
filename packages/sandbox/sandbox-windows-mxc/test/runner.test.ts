/**
 * MXC runner 的契约：
 *
 * 1. 纯函数（任何平台）：argv 互逆、请求映射、命令行引号、环境、MXC 拒绝的识别；
 * 2. 真实 runner 进程对着一个**假执行器**（`node stub.mjs <请求文件>`）端到端跑：请求内容、
 *    私有 temp 的生命周期、退出码镜像、MXC 拒绝 → 127 + 前缀、坏参数 → 127 且不启动执行器。
 *    真实的 MXC 只在 Windows 24H2+ 上存在，这一层不需要它。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MXC_CONTRACT_VERSIONS,
  RUNNER_FAILURE_EXIT_CODE,
  RUNNER_FAILURE_PREFIX,
  buildCommandLine,
  buildMxcRequest,
  buildRunnerArgs,
  childEnvironment,
  containerIdFor,
  loopbackProxyUrl,
  mxcErrorCode,
  mxcNetworkFields,
  mxcRequestRefusal,
  parseRunnerArgs,
  type MxcRunnerInvocation,
} from '../src/index.js'

const RUNNER = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'tnega-mxc-runner-')))
const workspace = join(scratch, 'workspace')
const tempRoot = join(scratch, 'temp')
const record = join(scratch, 'record.json')
const stub = join(scratch, 'stub.mjs')
mkdirSync(workspace)
mkdirSync(tempRoot)

// The fake executor: records the request it was handed (and whether its
// grants exist while it runs), then behaves as STUB_MODE says.
writeFileSync(stub, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const writable = request.filesystem.readwritePaths
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ request, requestPath: process.argv[2], grantsExist: writable.map(p => existsSync(p)) }))
process.stdout.write('ran:' + request.process.commandLine + '\\n')
const mode = process.env.STUB_MODE ?? 'ok'
if (mode === 'envelope') { process.stderr.write('partial output\\n{"error":{"code":"backend_unavailable","message":"no tier"}}\\n'); process.exit(1) }
if (mode === 'schema') { process.stderr.write("Request error\\nConfiguration parse error: Config schema version '1.0.0' is newer than supported (supported: >=0.6, <=0.9)\\n"); process.exit(1) }
if (mode === 'json-output') { process.stderr.write('{"error":"backend_error"}\\nthe command kept going\\n'); process.exit(3) }
process.exit(mode === 'ok' ? 0 : Number(mode))
`)

function invocation(overrides: Partial<MxcRunnerInvocation> = {}): MxcRunnerInvocation {
  return {
    workspace,
    mode: 'read-only',
    exec: process.execPath,
    contract: '1.0.0',
    containerId: containerIdFor(workspace),
    readOnlyRoots: [],
    execArgs: [stub],
    argv: ['cmd.exe', '/d', '/s', '/c', 'echo "a b" > out.txt'],
    ...overrides,
  }
}

function run(args: readonly string[], mode = 'ok'): { status: number | null; stdout: string; stderr: string } {
  rmSync(record, { force: true })
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, SYSTEMROOT: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', STUB_MODE: mode, ELECTRON_RUN_AS_NODE: '1' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

interface Recorded {
  request: {
    version: string
    process: { cwd: string; env: string[] }
    filesystem: { readwritePaths: string[] }
  }
  requestPath: string
  grantsExist: boolean[]
}

function recorded(): Recorded {
  const parsed: Recorded = JSON.parse(readFileSync(record, 'utf8'))
  return parsed
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('runner argv', () => {
  it('round-trips through build and parse', () => {
    const full = invocation({ mode: 'workspace-write', temp: tempRoot, readOnlyRoots: [scratch], execArgs: ['--debug'] })
    expect(parseRunnerArgs(buildRunnerArgs(full))).toEqual(full)
    expect(parseRunnerArgs(buildRunnerArgs(invocation()))).toEqual(invocation())
  })

  it.each([
    [['--mode', 'read-only'], /missing -- before the command/u],
    [buildRunnerArgs(invocation({ mode: 'workspace-write' })), /workspace-write requires --temp/u],
    [buildRunnerArgs(invocation({ temp: tempRoot })), /read-only does not accept --temp/u],
    [buildRunnerArgs(invocation({ contract: 'latest' })), /--contract must be/u],
    [buildRunnerArgs(invocation({ containerId: 'a b' })), /--container-id/u],
    [buildRunnerArgs(invocation({ workspace: 'relative' })), /paths must be absolute/u],
    [buildRunnerArgs(invocation({ argv: [] })), /missing command/u],
    [['--bogus', 'x', '--', 'cmd'], /unknown argument: --bogus/u],
  ])('refuses a malformed invocation %#', (args, message) => {
    expect(() => parseRunnerArgs(args)).toThrow(message)
  })

  it('derives a path-free container id that differs per session', () => {
    expect(containerIdFor(workspace, 'a')).toMatch(/^tnega-[0-9a-f]{24}$/u)
    expect(containerIdFor(workspace, 'a')).not.toBe(containerIdFor(workspace, 'b'))
    expect(containerIdFor(workspace, 'a')).toBe(containerIdFor(workspace, 'a'))
    expect(containerIdFor(workspace)).not.toContain('workspace')
  })

  it('speaks the 1.0.0 contract first and falls back to the 0.9 alpha', () => {
    expect(MXC_CONTRACT_VERSIONS).toEqual(['1.0.0', '0.9.0-alpha'])
  })
})

describe('runner network', () => {
  it('round-trips off and a loopback proxy, and leaves open implicit', () => {
    const off = invocation({ network: 'off' })
    expect(parseRunnerArgs(buildRunnerArgs(off))).toEqual(off)
    const proxied = invocation({ network: { proxy: 'http://127.0.0.1:8123' } })
    expect(parseRunnerArgs(buildRunnerArgs(proxied))).toEqual(proxied)
    expect(buildRunnerArgs(invocation({ network: 'open' }))).not.toContain('--network')
  })

  it('accepts only a loopback http:// proxy with a port', () => {
    expect(loopbackProxyUrl('http://127.0.0.1:8123/')).toBe('http://127.0.0.1:8123')
    expect(loopbackProxyUrl('http://[::1]:8123')).toBe('http://[::1]:8123')
    for (const bad of ['http://10.0.0.1:8123', 'https://127.0.0.1:8123', 'http://127.0.0.1', 'http://u:p@127.0.0.1:1', 'http://127.0.0.1:1/x', 'nope']) {
      expect(loopbackProxyUrl(bad), bad).toBeUndefined()
    }
    expect(() => parseRunnerArgs(['--network', 'http://example.com:80', ...buildRunnerArgs(invocation())]))
      .toThrow(/--network must be open, off or a loopback/u)
  })

  it('maps each mode to the MXC network block', () => {
    expect(mxcNetworkFields('open')).toEqual({ network: { egress: { default: 'allow' }, ingress: { default: 'allow', hostLoopback: 'allow' } } })
    expect(mxcNetworkFields('off')).toEqual({ network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } } })
    // Identity-less loopback proxy: egress denied, the host proxy reachable over loopback.
    expect(mxcNetworkFields({ proxy: 'http://127.0.0.1:8123' })).toEqual({
      network: { egress: { default: 'deny' }, ingress: { default: 'allow', hostLoopback: 'allow' } },
      runtimeConfig: { networkProxy: 'http://127.0.0.1:8123' },
    })
    const request = buildMxcRequest({
      contract: '1.0.0', mode: 'read-only', workspace, readOnlyRoots: [], commandLine: 'cmd', cwd: workspace,
      env: {}, containerId: 'tnega-x', network: { proxy: 'http://127.0.0.1:1' },
    })
    expect(request).toMatchObject({ runtimeConfig: { networkProxy: 'http://127.0.0.1:1' }, network: { egress: { default: 'deny' } } })
    expect(request).not.toHaveProperty('network.allowedProxyPeer')
  })
})

describe('command line', () => {
  it('passes a cmd /c command through verbatim so quotes and redirections survive', () => {
    expect(buildCommandLine(['cmd.exe', '/d', '/s', '/c', 'echo "a b" > "c d.txt"']))
      .toBe('cmd.exe /d /s /c "echo "a b" > "c d.txt""')
  })

  it('quotes every other program by the CommandLineToArgvW rules', () => {
    expect(buildCommandLine(['C:\\Program Files\\Git\\bin\\bash.exe', '-c', 'echo "hi" \\']))
      .toBe('"C:\\Program Files\\Git\\bin\\bash.exe" -c "echo \\"hi\\" \\\\"')
    expect(buildCommandLine(['pwsh', '-EncodedCommand', 'ZQBjAGgAbwA=', ''])).toBe('pwsh -EncodedCommand ZQBjAGgAbwA= ""')
  })
})

describe('request', () => {
  const base = {
    contract: '1.0.0', workspace: 'C:\\ws', readOnlyRoots: ['C:\\tools'], commandLine: 'cmd /c x',
    cwd: 'C:\\ws\\sub', env: { SYSTEMROOT: 'C:\\Windows', A: '1' }, containerId: 'tnega-x',
  }

  it('grants nothing writable in read-only and reads the workspace explicitly', () => {
    const request = buildMxcRequest({ ...base, mode: 'read-only' })
    expect(request).toMatchObject({
      version: '1.0.0',
      containment: 'processcontainer',
      containerId: 'tnega-x',
      process: { commandLine: 'cmd /c x', cwd: 'C:\\ws\\sub', env: ['A=1', 'SYSTEMROOT=C:\\Windows'] },
      filesystem: { readwritePaths: [], readonlyPaths: ['C:\\ws', 'C:\\tools'], deniedPaths: [] },
      ui: { disable: false, clipboard: 'none', injection: false },
      lifecycle: { destroyOnExit: true, preservePolicy: false },
    })
    // The seam does not govern the network, and MXC reads an omitted posture as deny.
    expect(request.network).toEqual({ egress: { default: 'allow' }, ingress: { default: 'allow', hostLoopback: 'allow' } })
    expect(JSON.stringify(request)).not.toContain('timeout')
  })

  it('grants the workspace and the private temp writable in workspace-write', () => {
    const request = buildMxcRequest({ ...base, mode: 'workspace-write', privateTemp: 'D:\\tmp\\tnega-mxc-1' })
    expect(request.filesystem).toEqual({
      readwritePaths: ['C:\\ws', 'D:\\tmp\\tnega-mxc-1'],
      readonlyPaths: ['C:\\tools'],
      deniedPaths: [],
    })
  })

  it('withholds runner-only variables and points TMP/TEMP at the private temp', () => {
    const env = childEnvironment({ Path: 'p', Temp: 'old', tmp: 'old', ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' }, 'D:\\t')
    expect(env).toEqual({ Path: 'p', TMP: 'D:\\t', TEMP: 'D:\\t' })
    expect(childEnvironment({ TEMP: 'kept' })).toEqual({ TEMP: 'kept' })
  })

  it('recognises MXC refusals only on the last stderr line', () => {
    expect(mxcErrorCode('out\n{"error":{"code":"policy_validation"}}\n')).toBe('policy_validation')
    expect(mxcErrorCode('{"error":"backend_error"}')).toBe('backend_error')
    expect(mxcErrorCode('{"error":"backend_error"}\nmore')).toBeUndefined()
    expect(mxcErrorCode('{"error":"made_up"}')).toBeUndefined()
    expect(mxcErrorCode('{not json')).toBeUndefined()
    expect(mxcRequestRefusal("Configuration parse error: Config schema version '1.0.0' is newer than supported"))
      .toMatch(/newer than supported/u)
    expect(mxcRequestRefusal('ordinary failure')).toBeUndefined()
  })
})

describe('runner process against a fake executor', () => {
  it('hands MXC a read-only request, relays output and mirrors success', () => {
    const result = run(buildRunnerArgs(invocation()))
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('ran:cmd.exe /d /s /c "echo "a b" > out.txt"\n')
    const { request, requestPath } = recorded()
    expect(request.version).toBe('1.0.0')
    expect(request.process.cwd).toBe(workspace)
    expect(request.filesystem.readwritePaths).toEqual([])
    expect(request.process.env.some(entry => entry.startsWith('ELECTRON_RUN_AS_NODE='))).toBe(false)
    // The request holds the child's environment: it must not outlive the call.
    expect(existsSync(requestPath)).toBe(false)
  })

  it('creates a private temp for workspace-write, publishes it as TMP/TEMP and removes it', () => {
    const result = run(buildRunnerArgs(invocation({ mode: 'workspace-write', temp: tempRoot })))
    expect(result.status).toBe(0)
    const { request, grantsExist } = recorded()
    const [granted, privateTemp] = request.filesystem.readwritePaths
    expect(granted).toBe(workspace)
    expect(privateTemp?.startsWith(join(tempRoot, 'tnega-mxc-'))).toBe(true)
    expect(grantsExist).toEqual([true, true])
    expect(request.process.env).toContain(`TEMP=${privateTemp}`)
    expect(existsSync(privateTemp!)).toBe(false)
  })

  it('mirrors the command exit code without claiming a runner failure', () => {
    const result = run(buildRunnerArgs(invocation()), '7')
    expect(result.status).toBe(7)
    expect(result.stderr).not.toContain(RUNNER_FAILURE_PREFIX)
  })

  it('does not mistake JSON a command printed for an MXC refusal', () => {
    const result = run(buildRunnerArgs(invocation()), 'json-output')
    expect(result.status).toBe(3)
    expect(result.stderr).not.toContain(RUNNER_FAILURE_PREFIX)
  })

  it.each([
    ['envelope', /MXC refused the request \(backend_unavailable\)/u],
    ['schema', /MXC refused the request: Configuration parse error: Config schema version/u],
  ])('turns an MXC %s refusal into the runner failure contract', (mode, message) => {
    const result = run(buildRunnerArgs(invocation()), mode)
    expect(result.status).toBe(RUNNER_FAILURE_EXIT_CODE)
    expect(result.stderr).toContain(RUNNER_FAILURE_PREFIX)
    expect(result.stderr).toMatch(message)
  })

  it('fails closed without starting the executor on bad arguments', () => {
    const result = run(['--workspace', workspace, '--', 'cmd'])
    expect(result.status).toBe(RUNNER_FAILURE_EXIT_CODE)
    expect(result.stderr).toMatch(/^mxc-sandbox-run: /u)
    expect(existsSync(record)).toBe(false)
  })

  it('refuses a temp root inside the workspace', () => {
    const nested = join(workspace, 'tmp')
    mkdirSync(nested, { recursive: true })
    const result = run(buildRunnerArgs(invocation({ mode: 'workspace-write', temp: nested })))
    expect(result.status).toBe(RUNNER_FAILURE_EXIT_CODE)
    expect(result.stderr).toMatch(/--temp must live outside the workspace/u)
    expect(existsSync(record)).toBe(false)
  })

  it('fails closed when the executor cannot start', () => {
    const result = run(buildRunnerArgs(invocation({ exec: join(scratch, 'missing-wxc-exec.exe'), execArgs: [] })))
    expect(result.status).toBe(RUNNER_FAILURE_EXIT_CODE)
    expect(result.stderr).toMatch(/mxc-sandbox-run: cannot start/u)
  })
})

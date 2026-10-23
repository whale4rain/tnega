/**
 * Windows 机制链：MXC 在前，原有的 ACL 受限令牌作回退。
 *
 * 探测被注入的用例在任何平台都跑；「真探测」用例用一个可执行的假 `wxc-exec`（带 shebang 的
 * Node 脚本）走完 Provider → runner → 执行器整条链，因此只在 POSIX 上跑 —— Windows 不能直接
 * 执行脚本文件，那里的真机验证属于发布前的手动验收（见包 README）。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { canonicalPath } from '@tnega/sandbox'
import { containerIdFor, parseRunnerArgs } from '@tnega/sandbox-windows-mxc'
import { LocalSandboxService, type Config, type SandboxRunnerName } from '../src/index.js'

const SHELL = ['cmd.exe', '/d', '/s', '/c', 'echo hi']
const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(dir)
  return dir
}

function mount(config: Config): LocalSandboxService {
  return new LocalSandboxService(new Context(), { workspaceRoot: process.cwd(), ...config })
}

describe('Windows chain', () => {
  it('tries MXC first and falls back to the ACL runner when MXC is unusable', async () => {
    const probed: SandboxRunnerName[] = []
    const service = mount({
      internals: {
        platform: 'win32',
        probe: (runner) => {
          probed.push(runner)
          return runner === 'windows-mxc' ? 'unusable' : 'partial'
        },
      },
    })
    expect(await service.status()).toEqual({ available: true, runner: 'windows-acl', enforcement: 'partial' })
    expect(probed).toEqual(['windows-mxc', 'windows-acl'])
  })

  it('reports MXC as partial and names it when its probe passes', async () => {
    const service = mount({ internals: { platform: 'win32', probe: () => 'partial' } })
    expect(await service.status()).toEqual({ available: true, runner: 'windows-mxc', enforcement: 'partial' })
  })

  it('wraps a workspace-write command in the MXC runner with a session-scoped container', async () => {
    const workspace = scratch('tnega-mxc-ws-')
    const tempRoot = scratch('tnega-mxc-tmp-')
    const volumeRoot = scratch('tnega-mxc-vol-')
    const service = mount({
      mxcExecPath: process.execPath,
      mxcReadOnlyRoots: [tempRoot],
      windowsMxcRunnerCommand: ['node', 'mxc-runner.js'],
      internals: { platform: 'win32', chain: ['windows-mxc'], probe: () => 'partial', volumeRoots: () => [volumeRoot] },
    })
    const confined = await service.confine({
      op: 'shell',
      argv: SHELL,
      policy: { mode: 'workspace-write', workspaceRoot: workspace, tempRoot, sessionId: 's1' },
    })
    expect(confined).toMatchObject({
      runner: 'windows-mxc',
      enforcement: 'partial',
      runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['mxc-sandbox-run: '] }],
    })
    expect(confined.denialSignatures).toContain('Access to the path')
    expect(confined.argv.slice(0, 2)).toEqual(['node', 'mxc-runner.js'])
    expect(parseRunnerArgs(confined.argv.slice(2))).toEqual({
      workspace,
      mode: 'workspace-write',
      exec: process.execPath,
      contract: '1.0.0',
      containerId: containerIdFor(workspace, 's1'),
      temp: tempRoot,
      // Every volume root is readable, then the explicitly configured ones: the seam
      // narrows writes only, exactly like the ACL chain.
      readOnlyRoots: [volumeRoot, tempRoot],
      execArgs: [],
      argv: SHELL,
    })
    // An explicitly configured runner is not one of the desktop's own workers.
    expect(confined.env).toBeUndefined()
  })

  it('grants no temp area in read-only', async () => {
    const service = mount({
      mxcExecPath: process.execPath,
      mxcContractVersion: '0.9.0-alpha',
      windowsMxcRunnerCommand: ['node', 'mxc-runner.js'],
      internals: { platform: 'win32', chain: ['windows-mxc'], probe: () => 'partial', volumeRoots: () => [] },
    })
    const confined = await service.confine({
      op: 'shell', argv: SHELL, policy: { mode: 'read-only', workspaceRoot: canonicalPath(process.cwd()) },
    })
    const parsed = parseRunnerArgs(confined.argv.slice(2))
    expect(parsed.temp).toBeUndefined()
    expect(parsed.contract).toBe('0.9.0-alpha')
  })

  it('keeps reads scoped to the workspace and the configured roots under mxcRead: roots', async () => {
    const workspace = scratch('tnega-mxc-ws-')
    const extra = scratch('tnega-mxc-extra-')
    const service = mount({
      mxcExecPath: process.execPath,
      mxcRead: 'roots',
      mxcReadOnlyRoots: [extra],
      windowsMxcRunnerCommand: ['node', 'mxc-runner.js'],
      internals: { platform: 'win32', chain: ['windows-mxc'], probe: () => 'partial', volumeRoots: () => [scratch('tnega-mxc-vol-')] },
    })
    const confined = await service.confine({
      op: 'shell', argv: SHELL, policy: { mode: 'read-only', workspaceRoot: workspace },
    })
    expect(parseRunnerArgs(confined.argv.slice(2)).readOnlyRoots).toEqual([extra])
  })

  it('runs the built-in runner as a desktop Node worker under Electron', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
    Object.defineProperty(process.versions, 'electron', { value: '44.4.3', configurable: true })
    try {
      const service = mount({
        mxcExecPath: process.execPath,
        internals: { platform: 'win32', chain: ['windows-mxc'], probe: () => 'partial', volumeRoots: () => [] },
      })
      const confined = await service.confine({
        op: 'shell', argv: SHELL, policy: { mode: 'read-only', workspaceRoot: canonicalPath(process.cwd()) },
      })
      expect(confined.argv[0]).toBe(process.execPath)
      expect(confined.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' })
    } finally {
      if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor)
      else Reflect.deleteProperty(process.versions, 'electron')
    }
  })

  it('is unusable off Windows without spawning anything', async () => {
    const service = mount({ internals: { platform: 'linux', chain: ['windows-mxc'] } })
    expect(await service.status()).toMatchObject({ available: false, detail: expect.stringContaining('Windows only') })
  })

  it('can be switched off with TNEGA_MXC_EXEC=off', async () => {
    const previous = process.env.TNEGA_MXC_EXEC
    process.env.TNEGA_MXC_EXEC = 'off'
    try {
      const service = mount({ internals: { platform: 'win32', chain: ['windows-mxc'] } })
      expect(await service.status()).toMatchObject({ available: false, detail: expect.stringContaining('TNEGA_MXC_EXEC=off') })
    } finally {
      if (previous === undefined) delete process.env.TNEGA_MXC_EXEC
      else process.env.TNEGA_MXC_EXEC = previous
    }
  })
})

describe.skipIf(process.platform === 'win32')('MXC functional probe through the real runner', () => {
  const saved = { SYSTEMROOT: process.env.SYSTEMROOT, LOCALAPPDATA: process.env.LOCALAPPDATA }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function fakeExecutor(script: string): { exec: string; log: string } {
    const dir = scratch('tnega-mxc-exec-')
    const exec = join(dir, 'wxc-exec')
    const log = join(dir, 'log.txt')
    writeFileSync(exec, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'))
appendFileSync(${JSON.stringify(log)}, request.version + ' ' + request.process.commandLine + '\\n')
${script}
`)
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    chmodSync(exec, 0o755)
    return { exec, log }
  }

  it('negotiates the contract the executor accepts and keeps using it', async () => {
    process.env.SYSTEMROOT = 'C:\\Windows'
    process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local'
    const { exec, log } = fakeExecutor(`
if (request.version === '1.0.0') {
  process.stderr.write("Configuration parse error: Config schema version '1.0.0' is newer than supported (supported: >=0.6, <=0.9)\\n")
  process.exit(1)
}`)
    const service = mount({
      mxcExecPath: exec,
      internals: { platform: 'win32', chain: ['windows-mxc'], volumeRoots: () => [] },
    })
    expect(await service.status()).toEqual({ available: true, runner: 'windows-mxc', enforcement: 'partial' })
    expect(readFileSync(log, 'utf8')).toBe('1.0.0 cmd.exe /d /s /c "exit 0"\n0.9.0-alpha cmd.exe /d /s /c "exit 0"\n')
    const confined = await service.confine({
      op: 'shell', argv: SHELL, policy: { mode: 'read-only', workspaceRoot: canonicalPath(process.cwd()) },
    })
    expect(parseRunnerArgs(confined.argv.slice(2)).contract).toBe('0.9.0-alpha')
  })

  it("falls back to the ACL runner with MXC's own reason when no contract is accepted", async () => {
    process.env.SYSTEMROOT = 'C:\\Windows'
    process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local'
    const { exec } = fakeExecutor(`process.stderr.write('{"error":{"code":"backend_unavailable"}}\\n'); process.exit(1)`)
    const service = mount({
      mxcExecPath: exec,
      internals: { platform: 'win32', chain: ['windows-mxc'] },
    })
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.detail).toMatch(/windows-mxc: contract 1\.0\.0: .*backend_unavailable.*contract 0\.9\.0-alpha/su)
  })
})

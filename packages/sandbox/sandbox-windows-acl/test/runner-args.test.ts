/**
 * runner 参数契约：
 *
 * 1. 纯解析/校验（进程内，任何平台）；
 * 2. 真实 runner 进程的失败契约——**先把 runner.ts 复制到一个隔离目录、旁边放一个「一被
 *    加载就抛」的假 koffi**，再直接 `node runner.ts`：
 *
 *    - 参数不合法 → 127 + `windows-acl-run: ` 前缀 + 具体原因，且 stderr 里**不出现**假
 *      koffi 的哨兵信息（证明校验发生在 koffi 加载之前）；
 *    - 参数完全合法 → 哨兵出现，证明校验通过之后才去解析原生绑定。
 *
 *    这个复制还顺带证明了 runner 自包含：它没有任何相对 import，复制到别处照样能被 Node 22
 *    的类型剥离直接执行。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { tempWriteSid, workspaceWriteSid } from '../src/index.js'
import {
  RunnerUsageError,
  applyPrivateTempEnvironment,
  buildCommandLine,
  deriveTempWriteSid,
  deriveWorkspaceWriteSid,
  parseRunnerArgs,
  validateRunnerInvocation,
} from '../src/runner.js'

const RUNNER_SOURCE = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
/** 隔离副本旁的假 koffi 一被加载就抛这个信息。 */
const KOFFI_SENTINEL = 'koffi sentinel: koffi must not be loaded before argument validation'

const scratchRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'tnega-acl-args-')))
const workspace = join(scratchRoot, 'workspace')
const tempDir = join(scratchRoot, 'temp')
const nestedTemp = join(workspace, 'nested-temp')
mkdirSync(workspace, { recursive: true })
mkdirSync(tempDir, { recursive: true })
mkdirSync(nestedTemp, { recursive: true })

const writeSid = workspaceWriteSid(workspace)
const privateTempSid = tempWriteSid(tempDir)
const nestedTempSid = tempWriteSid(nestedTemp)

let isolatedDir = ''

beforeAll(() => {
  isolatedDir = mkdtempSync(join(tmpdir(), 'tnega-acl-runner-copy-'))
  writeFileSync(join(isolatedDir, 'package.json'), JSON.stringify({ name: 'runner-copy-fixture', type: 'module' }))
  copyFileSync(RUNNER_SOURCE, join(isolatedDir, 'runner.ts'))
  const koffiDir = join(isolatedDir, 'node_modules', 'koffi')
  mkdirSync(koffiDir, { recursive: true })
  writeFileSync(join(koffiDir, 'package.json'), JSON.stringify({
    name: 'koffi',
    version: '0.0.0-test',
    type: 'module',
    main: 'index.js',
    exports: './index.js',
  }))
  writeFileSync(join(koffiDir, 'index.js'), `throw new Error(${JSON.stringify(KOFFI_SENTINEL)})\n`)
})

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
  if (isolatedDir !== '') rmSync(isolatedDir, { recursive: true, force: true })
})

interface RunnerResult {
  status: number | null
  stdout: string
  stderr: string
}

function runIsolatedRunner(args: readonly string[]): RunnerResult {
  const result = spawnSync(process.execPath, [join(isolatedDir, 'runner.ts'), ...args], {
    cwd: isolatedDir,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('parseRunnerArgs', () => {
  it('parses the full workspace-write form and keeps the wrapped argv intact', () => {
    const parsed = parseRunnerArgs([
      '--workspace', workspace, '--temp', tempDir, '--mode', 'workspace-write',
      '--write-sid', writeSid, '--temp-write-sid', privateTempSid,
      '--', 'cmd', '/c', 'echo ok',
    ])
    expect(parsed).toEqual({
      workspace,
      temp: tempDir,
      mode: 'workspace-write',
      writeSid,
      tempWriteSid: privateTempSid,
      command: 'cmd',
      args: ['/c', 'echo ok'],
    })
  })

  it('reports structural problems with a specific message', () => {
    expect(() => parseRunnerArgs([])).toThrow(/missing --workspace/u)
    expect(() => parseRunnerArgs(['--workspace'])).toThrow(/missing value after --workspace/u)
    expect(() => parseRunnerArgs(['--workspace', workspace, '--nope', 'x'])).toThrow(/unknown argument: --nope/u)
    expect(() => parseRunnerArgs(['--workspace', workspace, '--temp', tempDir, '--mode', 'read-only']))
      .toThrow(/missing command after --/u)
    expect(() => parseRunnerArgs(['--workspace', workspace, '--temp', tempDir, '--mode', 'bypass', '--', 'cmd']))
      .toThrow(/unknown mode: bypass/u)
    expect(() => parseRunnerArgs(['--temp', tempDir, '--mode', 'read-only', '--', 'cmd'])).toThrow(/missing --workspace/u)
    expect(() => parseRunnerArgs(['--workspace', workspace, '--mode', 'read-only', '--', 'cmd'])).toThrow(/missing --temp/u)
  })
})

describe('validateRunnerInvocation', () => {
  const base = { temp: tempDir, command: 'cmd', args: [] }

  it('rejects read-only carrying any SID', () => {
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'read-only', writeSid, tempWriteSid: undefined,
    })).toThrow(/read-only must not carry/u)
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'read-only', writeSid: undefined, tempWriteSid: privateTempSid,
    })).toThrow(/read-only must not carry/u)
  })

  it('rejects workspace-write missing either or both SIDs', () => {
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'workspace-write', writeSid: undefined, tempWriteSid: undefined,
    })).toThrow(/requires both --write-sid and --temp-write-sid/u)
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'workspace-write', writeSid, tempWriteSid: undefined,
    })).toThrow(/requires both/u)
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'workspace-write', writeSid: undefined, tempWriteSid: privateTempSid,
    })).toThrow(/requires both/u)
  })

  it('rejects SIDs that do not match their owning paths', () => {
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'workspace-write', writeSid: 'S-1-4-1-1', tempWriteSid: privateTempSid,
    })).toThrow(/--write-sid does not match --workspace/u)
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'workspace-write', writeSid, tempWriteSid: 'S-1-4-1-1-1',
    })).toThrow(/--temp-write-sid does not match --temp/u)
  })

  it('rejects relative and non-existent directories', () => {
    expect(() => validateRunnerInvocation({
      ...base, workspace: 'relative', mode: 'read-only', writeSid: undefined, tempWriteSid: undefined,
    })).toThrow(/must be an absolute path/u)
    expect(() => validateRunnerInvocation({
      ...base, workspace: join(scratchRoot, 'missing'), mode: 'read-only', writeSid: undefined, tempWriteSid: undefined,
    })).toThrow(/not an existing directory/u)
  })

  it('rejects a private temp inside the workspace', () => {
    expect(() => validateRunnerInvocation({
      workspace,
      temp: nestedTemp,
      mode: 'workspace-write',
      writeSid,
      tempWriteSid: nestedTempSid,
      command: 'cmd',
      args: [],
    })).toThrow(/--temp must be outside --workspace/u)
  })

  it('accepts both valid shapes', () => {
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'read-only', writeSid: undefined, tempWriteSid: undefined,
    })).not.toThrow()
    expect(() => validateRunnerInvocation({
      ...base, workspace, mode: 'workspace-write', writeSid, tempWriteSid: privateTempSid,
    })).not.toThrow()
    // runner 自己派生的 SID 必须能通过 runner 自己的校验（算法一致的自证）。
    expect(() => validateRunnerInvocation({
      workspace,
      temp: tempDir,
      mode: 'workspace-write',
      writeSid: deriveWorkspaceWriteSid(workspace),
      tempWriteSid: deriveTempWriteSid(tempDir),
      command: 'cmd',
      args: [],
    })).not.toThrow()
  })

  it('uses RunnerUsageError for every rejection', () => {
    expect(() => parseRunnerArgs([])).toThrow(RunnerUsageError)
  })
})

describe('applyPrivateTempEnvironment', () => {
  it('points TMP and TEMP at the private temp directory under workspace-write only', () => {
    const saved = { tmp: process.env.TMP, temp: process.env.TEMP }
    try {
      process.env.TMP = 'C:\\ambient-temp'
      process.env.TEMP = 'C:\\ambient-temp'
      // read-only：没有能力 SID，temp 写本来就被拒，环境保持原样。
      applyPrivateTempEnvironment('read-only', tempDir)
      expect(process.env.TMP).toBe('C:\\ambient-temp')
      expect(process.env.TEMP).toBe('C:\\ambient-temp')

      applyPrivateTempEnvironment('workspace-write', tempDir)
      expect(process.env.TMP).toBe(tempDir)
      expect(process.env.TEMP).toBe(tempDir)
    } finally {
      if (saved.tmp === undefined) delete process.env.TMP
      else process.env.TMP = saved.tmp
      if (saved.temp === undefined) delete process.env.TEMP
      else process.env.TEMP = saved.temp
    }
  })
})

describe('buildCommandLine', () => {
  it('passes the cmd /c payload verbatim, wrapped in one quote pair', () => {
    // cmd.exe 不按 CRT 规则解析 /c 之后的内容：这一段的引号必须留给 cmd 自己。
    expect(buildCommandLine('cmd.exe', ['/d', '/s', '/c', 'node -e "console.log(1)"']))
      .toBe('cmd.exe /d /s /c "node -e "console.log(1)""')
    expect(buildCommandLine('C:\\Windows\\System32\\cmd.exe', ['/c', 'echo "a b"']))
      .toBe('C:\\Windows\\System32\\cmd.exe /c "echo "a b""')
    expect(buildCommandLine('CMD.EXE', ['/K', 'echo hi'])).toBe('CMD.EXE /K "echo hi"')
  })

  it('keeps redirection and quotes in the payload untouched', () => {
    expect(buildCommandLine('cmd', ['/d', '/s', '/c', 'echo x> out.txt']))
      .toBe('cmd /d /s /c "echo x> out.txt"')
    // 以引号开头的命令：/s 剥掉的正是我们加的那一对。
    expect(buildCommandLine('cmd', ['/c', '"C:\\Program Files\\a.exe" --x']))
      .toBe('cmd /c ""C:\\Program Files\\a.exe" --x"')
    // 程序路径自身带空格时仍按 CRT 规则加引号。
    expect(buildCommandLine('C:\\Program Files\\cmd.exe', ['/c', 'echo a b']))
      .toBe('"C:\\Program Files\\cmd.exe" /c "echo a b"')
  })

  it('uses the CRT rules for everything that is not cmd', () => {
    expect(buildCommandLine('node', ['-e', 'a b'])).toBe('node -e "a b"')
    expect(buildCommandLine('node', ['/c', 'a b'])).toBe('node /c "a b"')
    expect(buildCommandLine('rg', ['--glob', 'a b', 'x'])).toBe('rg --glob "a b" x')
  })

  it('falls back to the CRT rules for a cmd without /c or /k', () => {
    expect(buildCommandLine('cmd.exe', ['/d', '/s'])).toBe('cmd.exe /d /s')
    expect(buildCommandLine('cmd.exe', [])).toBe('cmd.exe')
  })
})

describe('the real runner process fails closed', () => {
  it('exits 127 with the failure prefix and never mentions koffi when the arguments are wrong', () => {
    const cases: Array<readonly [string, readonly string[], RegExp]> = [
      ['missing --workspace', ['--temp', tempDir, '--mode', 'read-only', '--', 'cmd'], /missing --workspace/u],
      ['missing --temp', ['--workspace', workspace, '--mode', 'read-only', '--', 'cmd'], /missing --temp/u],
      ['read-only with a SID', [
        '--workspace', workspace, '--temp', tempDir, '--mode', 'read-only',
        '--write-sid', writeSid, '--', 'cmd',
      ], /read-only must not carry/u],
      ['workspace-write without SIDs', [
        '--workspace', workspace, '--temp', tempDir, '--mode', 'workspace-write', '--', 'cmd',
      ], /requires both --write-sid and --temp-write-sid/u],
      ['workspace-write with a foreign SID', [
        '--workspace', workspace, '--temp', tempDir, '--mode', 'workspace-write',
        '--write-sid', 'S-1-4-1-1', '--temp-write-sid', 'S-1-4-1-2', '--', 'cmd',
      ], /--write-sid does not match --workspace/u],
      ['relative directory', [
        '--workspace', 'relative', '--temp', tempDir, '--mode', 'read-only', '--', 'cmd',
      ], /must be an absolute path/u],
    ]
    for (const [label, args, message] of cases) {
      const result = runIsolatedRunner(args)
      expect(result.status, `${label} (stderr: ${result.stderr})`).toBe(127)
      expect(result.stderr.startsWith('windows-acl-run: '), label).toBe(true)
      expect(result.stderr, label).toMatch(message)
      expect(result.stderr, `${label}: koffi must not be loaded yet`).not.toContain(KOFFI_SENTINEL)
      expect(result.stdout, label).toBe('')
    }
  })

  it('loads koffi only after a fully valid invocation', () => {
    const result = runIsolatedRunner([
      '--workspace', workspace, '--temp', tempDir, '--mode', 'workspace-write',
      '--write-sid', writeSid, '--temp-write-sid', privateTempSid,
      '--', 'cmd', '/c', 'echo ok',
    ])
    expect(result.status).toBe(127)
    expect(result.stderr.startsWith('windows-acl-run: ')).toBe(true)
    expect(result.stderr).toContain(KOFFI_SENTINEL)
  })
})

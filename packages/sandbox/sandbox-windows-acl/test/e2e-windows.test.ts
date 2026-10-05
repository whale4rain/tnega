/**
 * 端到端（Windows-only，需要 koffi）：走完整条链路 —— Provider 侧派生 SID 并授予 ACE →
 * 按 argv 契约拼 runner → runner 进程内创建受限令牌 → 用继承的 stdio 跑 `cmd` → 原样镜像
 * 退出码。
 *
 * 用例覆盖三种可观察结果：
 * 1. workspace-write 下被授予的目录可写、命令能跑（正向对照，避免「全都失败」式的假绿）；
 * 2. workspace-write 下 workspace 之外**不可写**（白名单的另一半）；
 * 3. read-only 下 workspace 之内也**不可写**（没有能力 SID 就没有写权限）。
 *
 * 用 `cmd` 而不是 pwsh：`cmd.exe` 在任何 Windows 上都在，不引入额外跳过条件；被拒绝时的
 * 文案（含系统语言的“拒绝访问”）同时用来核对本包导出的 DENIAL_SIGNATURES。`cmd /c` 的命令文本
 * 还必须原样传给它（见 runner 里 buildCommandLine 的 cmd 特例），所以引号与重定向形态单独
 * 覆盖了一组回归用例。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isWindowsAclAvailable, win32 } from '../src/ffi.js'
import type { Win32Api } from '../src/ffi.js'
import { AclWriteGrant, DENIAL_SIGNATURES, RUNNER_FAILURE_EXIT_CODE, resolveRunnerCommand, tempWriteSid, workspaceWriteSid } from '../src/index.js'
import { writeIsAmbientlyAllowed } from './support/acl-reader.js'
import { isMsysShell, shellCommandArgv, systemShell } from '../../../execution/src/shell.js'
import { decodeOutput } from '../../../execution/src/index.js'

const e2eReady = process.platform === 'win32' && await isWindowsAclAvailable()

describe.skipIf(!e2eReady)('runner end-to-end under the real restricted token', () => {
  let api: Win32Api | undefined
  let scratchRoot = ''
  let workspace = ''
  let privateTemp = ''
  let outsideFile = ''
  let workspaceSid = ''
  let privateTempSid = ''
  let workspaceGrant: AclWriteGrant | undefined
  let tempGrant: AclWriteGrant | undefined

  beforeAll(async () => {
    api = await win32()
    // 路径必须规范化之后再派生 SID：runner 会用同一个字符串重新派生并比对。
    scratchRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'tnega-acl-e2e-')))
    workspace = join(scratchRoot, 'workspace')
    privateTemp = join(scratchRoot, 'private-temp')
    mkdirSync(workspace)
    mkdirSync(privateTemp)
    outsideFile = join(scratchRoot, 'escaped.txt')

    workspaceSid = workspaceWriteSid(workspace)
    privateTempSid = tempWriteSid(privateTemp)
    workspaceGrant = await AclWriteGrant.create(workspaceSid)
    await workspaceGrant.add(workspace) // 常驻：workspace 的复用缓存
    tempGrant = await AclWriteGrant.create(privateTempSid)
    await tempGrant.add(privateTemp, { revocable: true })
  })

  afterAll(async () => {
    await tempGrant?.dispose()
    await workspaceGrant?.dispose()
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  /**
   * 该目录是否因为 Everyone 的写 ACE 而**对受限令牌也可写**。
   *
   * Everyone 必须留在 restricting 列表里（去掉会让早期 DLL 初始化崩），因此它的写权限仍然
   * 满足写入侧的检查——这是 README 里记录的环境边界。本机如果命中了它，「workspace 之外
   * 不可写」这类断言就失去意义（被拒绝的原因不再是白名单），因此按这个判据跳过并说明。
   */
  function ambientEscapePossible(path: string): boolean {
    return api !== undefined && writeIsAmbientlyAllowed(api, path)
  }

  /**
   * 用本包解析出来的 runner 前缀跑一次受限命令。
   *
   * cwd 默认是 workspace：runner 把**自己的** cwd 交给子进程，因此相对路径的命令（例如
   * `echo x> out.txt`）落点就是 workspace。这也和 Provider 的用法一致（执行层用调用方要求的
   * cwd 启动 runner）。
   */
  function runConfined(args: readonly string[], cwd: string = workspace): { status: number | null; output: string } {
    const [program, ...prefix] = resolveRunnerCommand()
    expect(program).toBe(process.execPath)
    const result = spawnSync(program ?? process.execPath, [...prefix, ...args], {
      cwd,
      timeout: 30_000,
    })
    return { status: result.status, output: `${decodeOutput(result.stdout)}${decodeOutput(result.stderr)}` }
  }

  /** 本机是否有可用的 Windows PowerShell（功能探测，不是 where.exe）。 */
  let powershellVerdict: boolean | undefined
  function powershellAvailable(): boolean {
    powershellVerdict ??= spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '$true'],
      { encoding: 'utf8' },
    ).status === 0
    return powershellVerdict
  }

  function workspaceWriteArgs(command: readonly string[]): string[] {
    return [
      '--workspace', workspace, '--temp', privateTemp, '--mode', 'workspace-write',
      '--write-sid', workspaceSid, '--temp-write-sid', privateTempSid,
      '--', ...command,
    ]
  }

  function readOnlyArgs(command: readonly string[]): string[] {
    return [
      '--workspace', workspace, '--temp', realpathSync.native(tmpdir()), '--mode', 'read-only',
      '--', ...command,
    ]
  }

  it('workspace-write runs a command and mirrors its exit code 0', () => {
    const result = runConfined(workspaceWriteArgs(['cmd', '/c', 'echo', 'ok']))
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('ok')
  })

  it('workspace-write lets the confined child write inside the granted workspace', () => {
    const target = join(workspace, 'allowed.txt')
    const result = runConfined(workspaceWriteArgs(['cmd', '/c', 'echo', 'tnega', '1>', target]))
    expect(result.status, result.output).toBe(0)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('tnega')
  })

  it('workspace-write denies a write outside the granted trees (and says so in its dialect)', (ctx) => {
    ctx.skip(
      ambientEscapePossible(scratchRoot),
      `this host grants Everyone write on the scratch parent (the documented Everyone boundary): ${scratchRoot}`,
    )
    const result = runConfined(workspaceWriteArgs(['cmd', '/c', 'echo', 'tnega', '1>', outsideFile]))
    expect(result.status, result.output).not.toBe(0)
    expect(existsSync(outsideFile)).toBe(false)
    const lowered = result.output.toLowerCase()
    expect(DENIAL_SIGNATURES.some(signature => lowered.includes(signature)), result.output).toBe(true)
  })

  it('workspace-write denies a write into the ambient temp root (no implicit grant)', (ctx) => {
    const ambientTemp = realpathSync.native(tmpdir())
    ctx.skip(
      ambientEscapePossible(ambientTemp),
      `this host grants Everyone write on the ambient temp root (the documented Everyone boundary): ${ambientTemp}`,
    )
    const target = join(ambientTemp, `tnega-acl-ambient-${String(process.pid)}.txt`)
    const result = runConfined(workspaceWriteArgs(['cmd', '/c', 'echo', 'tnega', '1>', target]))
    expect(existsSync(target)).toBe(false)
    expect(result.status, result.output).not.toBe(0)
  })

  it('read-only runs commands but denies every write, even inside the workspace', () => {
    const echo = runConfined(readOnlyArgs(['cmd', '/c', 'echo', 'ok']))
    expect(echo.status, echo.output).toBe(0)
    expect(echo.output).toContain('ok')

    const target = join(workspace, 'read-only-blocked.txt')
    const denial = runConfined(readOnlyArgs(['cmd', '/c', 'echo', 'tnega', '1>', target]))
    expect(denial.status, denial.output).not.toBe(0)
    expect(existsSync(target)).toBe(false)
    const lowered = denial.output.toLowerCase()
    expect(DENIAL_SIGNATURES.some(signature => lowered.includes(signature)), denial.output).toBe(true)
  })

  it('mirrors a non-zero exit code from the confined child unchanged', () => {
    const result = runConfined(workspaceWriteArgs(['cmd', '/c', 'exit', '3']))
    expect(result.status, result.output).toBe(3)
  })

  it('reads non-ASCII output of the system shell under read-only, without error noise', (ctx) => {
    const shell = systemShell()
    ctx.skip(isMsysShell(shell), 'MSYS bash cannot run under a restricted token; the sandbox rejects it up front')
    const [program, ...prefix] = resolveRunnerCommand()
    const result = spawnSync(program ?? process.execPath, [...prefix, ...readOnlyArgs(shellCommandArgv(shell, 'echo 中文-ok'))], { cwd: workspace, timeout: 30_000 })
    const stdout = decodeOutput(result.stdout)
    const stderr = decodeOutput(result.stderr)
    expect(result.status, stderr).toBe(0)
    expect(stdout.trim()).toBe('中文-ok')
    expect(stderr).toBe('')
  })

  it('runs the system shell (PowerShell) with quotes, pipes and a workspace write', (ctx) => {
    const shell = systemShell()
    ctx.skip(isMsysShell(shell), 'MSYS bash cannot run under a restricted token; the sandbox rejects it up front')
    const target = join(workspace, 'system-shell.txt')
    rmSync(target, { force: true })
    const command = shell.kind === 'pwsh' || shell.kind === 'powershell'
      ? 'Write-Output "a b" | Out-File -Encoding ascii system-shell.txt; Write-Output "done"; exit 4'
      : shell.kind === 'cmd' ? 'echo a b> system-shell.txt& echo done& exit /b 4'
      : 'echo "a b" > system-shell.txt; echo done; exit 4'
    const result = runConfined(workspaceWriteArgs(shellCommandArgv(shell, command)))
    expect(result.status, result.output).toBe(4)
    expect(result.output).toContain('done')
    // Plain text only: no serialized CLIXML error records, no failed encoding setup.
    expect(result.output).not.toMatch(/CLIXML|InvalidOperation/)
    expect(readFileSync(target, 'utf8')).toContain('a b')
    rmSync(target, { force: true })
  })

  /*
   * cmd.exe 的特例：它不按 CRT/CommandLineToArgvW 规则解析 /c 之后的文本，因此 runner 把这一段
   * 按原样包进一对引号交给 cmd 的 /s 语义。下面几条是这条规则的回归覆盖——全部是「引号/重定向
   * 出现在命令行里」的形态，之前的实现会把 `\"` 原样留在命令里、把重定向符包进引号而失效。
   */

  it('cmd /c runs a quoted node -e payload and reports its stdout', () => {
    const result = runConfined(workspaceWriteArgs(['cmd', '/d', '/s', '/c', 'node -e "console.log(2+2)"']))
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('4')
  })

  it('cmd /c mirrors the exit code of a quoted node payload', () => {
    const result = runConfined(workspaceWriteArgs(['cmd', '/d', '/s', '/c', 'node -e "process.exit(7)"']))
    expect(result.status, result.output).toBe(7)
  })

  it('cmd /c applies a relative redirection inside the granted workspace', () => {
    const target = join(workspace, 'out.txt')
    rmSync(target, { force: true })
    const result = runConfined(workspaceWriteArgs(['cmd', '/d', '/s', '/c', 'echo x> out.txt']))
    expect(result.status, result.output).toBe(0)
    expect(existsSync(target), result.output).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('x')
    rmSync(target, { force: true })
  })

  it('cmd /c runs a quoted powershell payload verbatim', (ctx) => {
    ctx.skip(!powershellAvailable(), 'powershell is not available on this host')
    const result = runConfined(
      workspaceWriteArgs(['cmd', '/d', '/s', '/c', 'powershell -NoProfile -Command "Write-Output pwsh-ok"']),
    )
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('pwsh-ok')
  })

  it('cmd /c keeps the write boundary when the payload redirects outside the grant', (ctx) => {
    ctx.skip(
      ambientEscapePossible(scratchRoot),
      `this host grants Everyone write on the scratch parent (the documented Everyone boundary): ${scratchRoot}`,
    )
    const target = join(scratchRoot, 'cmd-should-not-exist.txt')
    const result = runConfined(workspaceWriteArgs(['cmd', '/d', '/s', '/c', `echo outside> "${target}"`]))
    // 命令真的跑了（不是 runner 自己失败），但产物不存在。
    expect(result.status, result.output).not.toBe(RUNNER_FAILURE_EXIT_CODE)
    expect(existsSync(target)).toBe(false)
  })
})

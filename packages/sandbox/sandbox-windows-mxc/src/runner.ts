/**
 * windows-mxc 受限执行 runner：Provider 在调用方命令之前插入的那一层 argv 前缀。
 *
 * 沙箱缝交出的是 argv，而 Microsoft eXecution Container（MXC）的执行器 `wxc-exec.exe`
 * 要的是一份 JSON 请求。这层形状转换必须有一个进程来做：它为**这一次**调用写请求、调用
 * 执行器、镜像退出码，然后删掉请求文件与私有 temp 目录。Provider 本身因此不持有任何宿主
 * 状态 —— MXC 在请求结束时撤销它自己落下的 ACE。
 *
 * ## argv 契约
 *
 * ```text
 * [node, <runner>, '--workspace', <绝对目录>, '--mode', <read-only|workspace-write>,
 *  '--exec', <wxc-exec 路径>, '--contract', <版本>, '--container-id', <id>,
 *  ['--temp', <绝对目录>], ['--network', <open|off|http://127.0.0.1:端口>],
 *  ['--read-only-root', <目录>]..., ['--exec-arg', <参数>]..., '--', ...argv]
 * ```
 *
 * - `--network` 缺省为 `open`（不限制）；`off` 断开一切网络；回环代理 URL 表示「只能经这个
 *   HTTP/S 代理出去」（MXC 的代理模式，见 {@link buildMxcRequest}）。
 *
 * - `workspace-write` 必须给 `--temp`：runner 在它下面为本次调用建一个私有目录，授予读写，
 *   并把 TMP/TEMP 指过去；`read-only` 不接受 `--temp`，什么都不可写。
 * - 两种模式都把 workspace 授予**读**：MXC 的 AppContainer 档位没有环境读权限，不授予的话
 *   命令连自己的输入都读不到。
 *
 * ## 为什么这个文件自包含
 *
 * 与 `@tnega/sandbox-windows-acl` 的 runner 同一个理由：Node 22 的类型剥离不会把 `./x.js`
 * 映射到 `./x.ts`，所以这里只依赖 `node:*`。包入口从这里再导出纯函数，Provider 与 runner
 * 因此共用同一份 argv 构造与解析，两半不会漂移。
 *
 * ## 失败契约
 *
 * runner 自己的任何失败（参数、目录、执行器起不来、MXC 拒绝请求）都在 stderr 写一行
 * `mxc-sandbox-run: <detail>` 并以 **127** 退出，绝不以非受限方式启动目标命令。正常路径
 * 返回执行器镜像的、被包裹命令的退出码。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** runner 侧失败信息的前缀（stderr 的一行）。 */
export const RUNNER_FAILURE_PREFIX = 'mxc-sandbox-run: '

/** runner 侧失败时的退出码（与 windows-acl runner 一致）。 */
export const RUNNER_FAILURE_EXIT_CODE = 127

/**
 * runner 会说的 MXC 请求契约版本，按优先级排列。MXC 精确校验版本、拒绝自己不支持的
 * 版本（`@microsoft/mxc-sdk` 0.8 的执行器只认 `>=0.6, <=0.9`），两个版本的一次性请求
 * 形状相同，所以 Provider 的探测按顺序试，选第一个被执行器接受的。
 */
export const MXC_CONTRACT_VERSIONS = ['1.0.0', '0.9.0-alpha'] as const

/** 本机制可以强制的两种模式。`bypass` 不是受限策略，不在机制库的词汇里。 */
export type MxcSandboxMode = 'read-only' | 'workspace-write'

/**
 * 命令的网络：`open` 不限制；`off` 全部断开；`{ proxy }` 只能经宿主上的回环 HTTP/S 代理出去。
 */
export type MxcNetwork = 'open' | 'off' | { proxy: string }

/**
 * 代理 URL 必须是回环上的 `http://`：MXC 拒绝非回环端点，而且代理就跑在宿主上。
 * @returns 规范化后的 URL；不合格时返回 `undefined`。
 */
export function loopbackProxyUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' || url.port === '' || url.username !== '' || url.pathname !== '/') return undefined
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return undefined
  return `http://${url.host}`
}

function parseNetwork(value: string | undefined): MxcNetwork {
  if (value === undefined || value === 'open') return 'open'
  if (value === 'off') return 'off'
  const proxy = loopbackProxyUrl(value)
  if (proxy === undefined) throw new Error(`--network must be open, off or a loopback http:// proxy URL; received ${value}`)
  return { proxy }
}

function networkArg(network: MxcNetwork): string {
  return typeof network === 'string' ? network : network.proxy
}

/** 解析后的 runner 参数。 */
export interface MxcRunnerInvocation {
  workspace: string
  mode: MxcSandboxMode
  /** MXC 执行器（`wxc-exec.exe`）。 */
  exec: string
  /** 请求里的 `version`。 */
  contract: string
  containerId: string
  /** `workspace-write` 的私有 temp 父目录；`read-only` 下缺席。 */
  temp?: string
  /** 命令的网络；缺席等同于 `open`。 */
  network?: MxcNetwork
  /** 额外的只读根（工作区之外命令需要读的目录）。 */
  readOnlyRoots: readonly string[]
  /** 放在请求文件路径之前、交给执行器的额外参数（诊断用，例如 `--debug`）。 */
  execArgs: readonly string[]
  /** 被包裹的命令。 */
  argv: readonly string[]
}

const VALUE_FLAGS = {
  '--workspace': 'workspace',
  '--mode': 'mode',
  '--exec': 'exec',
  '--contract': 'contract',
  '--container-id': 'containerId',
  '--temp': 'temp',
  '--network': 'network',
} as const

const REPEAT_FLAGS = {
  '--read-only-root': 'readOnlyRoots',
  '--exec-arg': 'execArgs',
} as const

function isValueFlag(token: string): token is keyof typeof VALUE_FLAGS {
  return Object.hasOwn(VALUE_FLAGS, token)
}

function isRepeatFlag(token: string): token is keyof typeof REPEAT_FLAGS {
  return Object.hasOwn(REPEAT_FLAGS, token)
}

/**
 * 拼 runner 自己的参数（不含 `[node, runner]` 前缀）。与 {@link parseRunnerArgs} 互逆，
 * 有测试钉住。
 */
export function buildRunnerArgs(invocation: MxcRunnerInvocation): string[] {
  return [
    '--workspace', invocation.workspace,
    '--mode', invocation.mode,
    '--exec', invocation.exec,
    '--contract', invocation.contract,
    '--container-id', invocation.containerId,
    ...(invocation.temp === undefined ? [] : ['--temp', invocation.temp]),
    ...(invocation.network === undefined || invocation.network === 'open' ? [] : ['--network', networkArg(invocation.network)]),
    ...invocation.readOnlyRoots.flatMap(root => ['--read-only-root', root]),
    ...invocation.execArgs.flatMap(argument => ['--exec-arg', argument]),
    '--',
    ...invocation.argv,
  ]
}

/**
 * 解析并校验 runner 参数。
 * @throws Error 指出出错的参数；runner 把它变成失败前缀 + 127，绝不带病执行。
 */
export function parseRunnerArgs(raw: readonly string[]): MxcRunnerInvocation {
  const values: Partial<Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>> = {}
  const repeats: Record<(typeof REPEAT_FLAGS)[keyof typeof REPEAT_FLAGS], string[]> = {
    readOnlyRoots: [],
    execArgs: [],
  }
  let index = 0
  for (; index < raw.length; index += 1) {
    const token = raw[index]!
    if (token === '--') break
    const value = raw[index + 1]
    if (isValueFlag(token)) {
      if (value === undefined) throw new Error(`missing value after ${token}`)
      const key = VALUE_FLAGS[token]
      if (values[key] !== undefined) throw new Error(`${token} given twice`)
      values[key] = value
      index += 1
      continue
    }
    if (isRepeatFlag(token)) {
      if (value === undefined) throw new Error(`missing value after ${token}`)
      repeats[REPEAT_FLAGS[token]].push(value)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${token}`)
  }
  if (index >= raw.length) throw new Error('missing -- before the command')
  const argv = raw.slice(index + 1)
  const { workspace, mode, exec, contract, containerId, temp } = values
  const network = parseNetwork(values.network)
  if (workspace === undefined) throw new Error('missing --workspace')
  if (mode !== 'read-only' && mode !== 'workspace-write') throw new Error(`unknown --mode: ${String(mode)}`)
  if (exec === undefined) throw new Error('missing --exec')
  if (contract === undefined || !/^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/u.test(contract)) {
    throw new Error(`--contract must be an MXC contract version such as 1.0.0; received ${String(contract)}`)
  }
  if (containerId === undefined || !/^[A-Za-z0-9-]{1,64}$/u.test(containerId)) {
    throw new Error(`--container-id must be 1-64 letters, digits or dashes; received ${String(containerId)}`)
  }
  if (mode === 'workspace-write' && temp === undefined) throw new Error('workspace-write requires --temp')
  if (mode === 'read-only' && temp !== undefined) throw new Error('read-only does not accept --temp')
  if (argv.length === 0 || argv[0] === '') throw new Error('missing command after --')
  for (const path of [workspace, ...(temp === undefined ? [] : [temp]), ...repeats.readOnlyRoots]) {
    if (!isAbsolute(path)) throw new Error(`paths must be absolute: ${path}`)
  }
  return {
    workspace, mode, exec, contract, containerId,
    ...(temp === undefined ? {} : { temp }),
    ...(network === 'open' ? {} : { network }),
    readOnlyRoots: repeats.readOnlyRoots,
    execArgs: repeats.execArgs,
    argv,
  }
}

/**
 * MXC 跟踪策略用的容器 id。MXC 要求并发的 Windows 策略修改使用不同的容器 id，而同一个
 * 工作区上会并发跑多个 Session：按（规范化工作区, Session）派生，让并发会话互不相同、
 * 同一会话的重复调用复用 MXC 的记账。无 Session 的调用退回到只按工作区。
 */
export function containerIdFor(workspace: string, sessionId?: string): string {
  const identity = JSON.stringify(sessionId === undefined ? [workspace] : [workspace, sessionId])
  return `tnega-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

/** 只属于 runner 自己的启动环境，不交给被包裹的命令。 */
const RUNNER_ONLY_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'TNEGA_DESKTOP_ACL_RUNNER'])
const TEMP_ENV = new Set(['TMP', 'TEMP'])

/**
 * 被包裹命令拿到的环境：runner 自己的环境（执行层已组装好），去掉 runner 专属的启动
 * 标记；`workspace-write` 下把 TMP/TEMP 指向被授予的私有目录。Windows 的环境变量名
 * 大小写不敏感，所以按大写比较 —— 残留一个 `Temp` 会盖掉授权。
 */
export function childEnvironment(env: NodeJS.ProcessEnv, privateTemp?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.length === 0) continue
    const name = key.toUpperCase()
    if (RUNNER_ONLY_ENV.has(name)) continue
    if (privateTemp !== undefined && TEMP_ENV.has(name)) continue
    out[key] = value
  }
  if (privateTemp !== undefined) {
    out.TMP = privateTemp
    out.TEMP = privateTemp
  }
  return out
}

/** MXC 在显式环境里要求的平台变量；缺了它会拒绝启动。 */
export function missingLaunchVariables(env: Readonly<Record<string, string>>): string[] {
  const names = new Set(Object.keys(env).map(name => name.toUpperCase()))
  return ['SYSTEMROOT', 'LOCALAPPDATA'].filter(name => !names.has(name))
}

/** 按 CommandLineToArgvW 的解析规则给一个参数加引号。 */
export function quoteArg(argument: string): string {
  if (argument === '') return '""'
  if (!/[\s"]/u.test(argument)) return argument
  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    else quoted += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

function isCmdProgram(program: string): boolean {
  const base = (program.split(/[\\/]/u).pop() ?? '').toLowerCase()
  return base === 'cmd' || base === 'cmd.exe'
}

/**
 * 拼 MXC `process.commandLine` 需要的那一行。
 *
 * **cmd.exe 是特例**（与 windows-acl runner 的同名函数同一规则）：它不按 CRT 规则解析
 * `/c`、`/k` 之后的文本，`\"` 会原样留在命令里、重定向符会被引号包住而失效。所以命令
 * 部分按原样包进一对引号，交给 `/s` 剥掉外层引号后逐字执行 —— 这也是 Node 的
 * `shell: true` 的构造方式。cmd 之外（bash / pwsh / node …）保持完整的 CRT 引号规则。
 */
export function buildCommandLine(argv: readonly string[]): string {
  const [program, ...args] = argv
  if (program === undefined || program === '') throw new Error('cannot build a command line for an empty argv')
  if (isCmdProgram(program)) {
    const switchIndex = args.findIndex(argument => argument.toLowerCase() === '/c' || argument.toLowerCase() === '/k')
    if (switchIndex >= 0) {
      const switches = [program, ...args.slice(0, switchIndex + 1)].map(quoteArg).join(' ')
      return `${switches} "${args.slice(switchIndex + 1).join(' ')}"`
    }
  }
  return [program, ...args].map(quoteArg).join(' ')
}

/** {@link buildMxcRequest} 的输入。 */
export interface MxcRequestOptions {
  contract: string
  mode: MxcSandboxMode
  workspace: string
  /** `workspace-write` 下被授予读写的私有 temp 目录。 */
  privateTemp?: string
  readOnlyRoots: readonly string[]
  /** 缺席等同于 `open`。 */
  network?: MxcNetwork
  commandLine: string
  cwd: string
  env: Readonly<Record<string, string>>
  containerId: string
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  return [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0))]
}

/**
 * 一次受限执行的 MXC 一次性请求。纯函数：整份受限决策可以不起进程地审阅与测试。
 *
 * 取舍（都已在参考实现的真机验收里观察过）：
 *
 * - `ui.disable: false`：MXC 默认禁 Win32k，PowerShell 与 Node 会以 0xC0000142 在启动时
 *   死掉；沙箱缝的模式只管文件效果，桌面保持与非受限时一样可达，剪贴板与输入注入仍关闭。
 * - 网络按 {@link MxcNetwork}：
 *   - `open`：两个方向都显式 `allow`（省略在 MXC 里等于拒绝）；
 *   - `off`：MXC 的「完全阻断」：出入与宿主回环全部 `deny`；
 *   - `{ proxy }`：MXC 的代理模式（ProcessContainer 文档的 Model 2）。出站默认拒绝，WFP 只放行
 *     到这个回环端点的连接，MXC 同时为容器设好 WinHTTP 代理与 `HTTP(S)_PROXY`。代理是宿主上
 *     的普通进程（没有包身份），按 MXC 的要求取「无身份回环代理」这一档：
 *     `ingress.default: allow` + `hostLoopback: allow`，不给 `allowedProxyPeer`。
 * - 不设执行超时：命令的期限属于执行层，第二个期限会把超时报成 MXC 的结果。
 * - `preservePolicy: false`：本次请求落下的 ACE 在结束时撤销，不留常驻宿主状态。
 */
export function buildMxcRequest(options: MxcRequestOptions): Record<string, unknown> {
  const { contract, mode, workspace, privateTemp, readOnlyRoots, commandLine, cwd, env, containerId } = options
  const network = options.network ?? 'open'
  const readwritePaths = mode === 'workspace-write' ? uniquePaths([workspace, privateTemp]) : []
  const readonlyPaths = mode === 'workspace-write'
    ? uniquePaths(readOnlyRoots)
    : uniquePaths([workspace, ...readOnlyRoots])
  return {
    version: contract,
    containment: 'processcontainer',
    containerId,
    process: {
      commandLine,
      cwd,
      env: Object.entries(env).map(([key, value]) => `${key}=${value}`).sort(),
    },
    filesystem: { readwritePaths, readonlyPaths, deniedPaths: [] },
    ...mxcNetworkFields(network),
    ui: { disable: false, clipboard: 'none', injection: false },
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    fallback: { allowDaclMutation: true },
  }
}

/** 请求里与网络有关的字段：`network`，代理模式下还有 `runtimeConfig.networkProxy`。 */
export function mxcNetworkFields(network: MxcNetwork): Record<string, unknown> {
  if (network === 'open') {
    return { network: { egress: { default: 'allow' }, ingress: { default: 'allow', hostLoopback: 'allow' } } }
  }
  if (network === 'off') {
    return { network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } } }
  }
  return {
    network: { egress: { default: 'deny' }, ingress: { default: 'allow', hostLoopback: 'allow' } },
    runtimeConfig: { networkProxy: network.proxy },
  }
}

/** MXC 封闭的线上错误码集合：它出现在 stderr 最后一行的 JSON 里，就是 MXC 自己拒绝了请求。 */
export const MXC_ERROR_CODES: readonly string[] = [
  'malformed_request',
  'unsupported_containment',
  'unsupported_phase',
  'backend_unavailable',
  'malformed_id',
  'stale_id',
  'not_provisioned',
  'not_started',
  'already_started',
  'already_stopped',
  'policy_validation',
  'backend_error',
]

/** 只保留 stderr 尾部用于识别，避免无界命令的 stderr 全部驻留内存。 */
const TAIL_LIMIT = 8 * 1024

export function appendTail(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length <= TAIL_LIMIT ? combined : combined.slice(combined.length - TAIL_LIMIT)
}

/** 最后一个非空行（去掉首尾空白）。 */
export function lastLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0)
  return lines.at(-1)
}

/**
 * 识别 stderr **最后一行**上的 MXC 错误信封，返回其错误码。要求「最后一行」且「已知错误码」，
 * 这样一个只是打印了 JSON 的命令不会被误判成沙箱失败。
 */
export function mxcErrorCode(stderrTail: string): string | undefined {
  const last = lastLine(stderrTail)
  if (last === undefined || !last.startsWith('{')) return undefined
  let envelope: unknown
  try {
    envelope = JSON.parse(last)
  } catch {
    return undefined
  }
  if (envelope === null || typeof envelope !== 'object' || !('error' in envelope)) return undefined
  const error: unknown = envelope.error
  const code = typeof error === 'string'
    ? error
    : error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' && MXC_ERROR_CODES.includes(code) ? code : undefined
}

/**
 * MXC 在执行前以纯文本报告的请求拒绝（例如「Config schema version '1.0.0' is newer than
 * supported」）。只在执行器非零退出、且这是 stderr 最后一行时才算数。
 */
const REQUEST_REFUSALS = [/config schema version/iu, /configuration parse error/iu, /^request error/iu]

export function mxcRequestRefusal(stderrTail: string): string | undefined {
  const last = lastLine(stderrTail)
  return last !== undefined && REQUEST_REFUSALS.some(pattern => pattern.test(last)) ? last : undefined
}

/* ---------------------------------- 入口 ---------------------------------- */

class RunnerFailure extends Error {}

function fail(detail: string): never {
  throw new RunnerFailure(detail)
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function requireDirectory(label: string, path: string): void {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

/** `inner` 是否就是 `outer` 或在它之下（Windows 上大小写不敏感）。 */
function isSameOrInside(outer: string, inner: string): boolean {
  const fold = (path: string): string => (process.platform === 'win32' ? canonical(path).toLowerCase() : canonical(path))
  const rel = relative(fold(outer), fold(inner))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function removeDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    // 清理失败不掩盖命令的退出码；残留的 temp 是惰性的。
    process.stderr.write(`${RUNNER_FAILURE_PREFIX}cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * 运行执行器。stdin/stdout 继承（命令的字节不被重新分帧）；stderr 经管道原样转发，同时保留
 * 尾部，用来把 MXC 自己的拒绝变成 runner 的失败签名。
 */
async function runExecutor(invocation: MxcRunnerInvocation, requestPath: string): Promise<number> {
  const child = spawn(invocation.exec, [...invocation.execArgs, requestPath], {
    stdio: ['inherit', 'inherit', 'pipe'],
    windowsHide: true,
  })
  let tail = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    process.stderr.write(chunk)
    tail = appendTail(tail, chunk)
  })
  const outcome = await new Promise<{ code: number | null } | { error: Error }>((settle) => {
    child.once('error', error => settle({ error }))
    child.once('close', code => settle({ code }))
  })
  if ('error' in outcome) fail(`cannot start ${invocation.exec}: ${outcome.error.message}`)
  const code = outcome.code ?? 1
  if (code !== 0) {
    const envelope = mxcErrorCode(tail)
    if (envelope !== undefined) fail(`MXC refused the request (${envelope}): ${lastLine(tail) ?? ''}`)
    const refusal = mxcRequestRefusal(tail)
    if (refusal !== undefined) fail(`MXC refused the request: ${refusal}`)
  }
  return code
}

/**
 * runner 主体：解析与校验 → 私有 temp（workspace-write）→ 写请求 → 执行 → 清理。
 * @returns 被包裹命令的退出码。
 */
export async function main(rawArgs: readonly string[]): Promise<number> {
  let invocation: MxcRunnerInvocation
  try {
    invocation = parseRunnerArgs(rawArgs)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const workspace = canonical(invocation.workspace)
  requireDirectory('--workspace', workspace)
  if (invocation.temp !== undefined) {
    requireDirectory('--temp', invocation.temp)
    if (isSameOrInside(workspace, invocation.temp)) {
      fail(`--temp must live outside the workspace: workspace=${workspace} temp=${invocation.temp}`)
    }
  }
  // 请求里带着子进程的完整环境，所以它所在的目录只为本次调用存在，结束即删。
  const scratch = mkdtempSync(join(tmpdir(), 'tnega-mxc-req-'))
  let privateTemp: string | undefined
  try {
    if (invocation.temp !== undefined) privateTemp = canonical(mkdtempSync(join(invocation.temp, 'tnega-mxc-')))
    const env = childEnvironment(process.env, privateTemp)
    const missing = missingLaunchVariables(env)
    if (missing.length > 0) fail(`MXC refuses an environment without ${missing.join(', ')}`)
    const request = buildMxcRequest({
      contract: invocation.contract,
      mode: invocation.mode,
      workspace,
      ...(privateTemp === undefined ? {} : { privateTemp }),
      readOnlyRoots: invocation.readOnlyRoots.map(canonical),
      ...(invocation.network === undefined ? {} : { network: invocation.network }),
      commandLine: buildCommandLine(invocation.argv),
      // 执行层以命令的工作目录启动 runner；省略 cwd 会让 MXC 自己挑默认值。
      cwd: process.cwd(),
      env,
      containerId: invocation.containerId,
    })
    const requestPath = join(scratch, 'request.json')
    writeFileSync(requestPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 })
    return await runExecutor(invocation, requestPath)
  } finally {
    removeDirectory(scratch)
    if (privateTemp !== undefined) removeDirectory(privateTemp)
  }
}

function modulePath(): string {
  const meta: ImportMeta & { filename?: string } = import.meta
  return typeof meta.filename === 'string' ? meta.filename : fileURLToPath(import.meta.url)
}

/** 这个文件自己的两种形态：仓库内的源码与构建出的独立 runner。 */
const RUNNER_FILE = /(?:^|[\\/])(?:runner\.ts|sandbox-windows-mxc-runner\.js)$/iu

/**
 * 是否由 `node <runner>` 直接执行（被 import 时绝不启动 main）。
 *
 * 包入口会再导出这里的纯函数，于是构建会把本文件**打进**别的包（CLI 的 `bin.js`、桌面端的
 * `main.js`）。那时 `import.meta.url` 就是那个包自己，单比较入口路径会让 runner 在 CLI 里
 * 启动；所以还要求本模块的文件名就是 runner。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined || !RUNNER_FILE.test(modulePath())) return false
  const normalize = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  return normalize(modulePath()) === normalize(entry)
}

/**
 * 退出。桌面端以 Electron utility process 承载 runner，它为 IPC 通道常驻，只设
 * `process.exitCode` 不会结束进程；先等 stderr 写完再显式退出。
 */
function finish(code: number): void {
  process.exitCode = code
  if ('type' in process && process.type === 'utility') process.stderr.write('', () => process.exit(code))
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(finish, (error: unknown) => {
    process.stderr.write(`${RUNNER_FAILURE_PREFIX}${error instanceof Error ? error.message : String(error)}\n`)
    finish(RUNNER_FAILURE_EXIT_CODE)
  })
}

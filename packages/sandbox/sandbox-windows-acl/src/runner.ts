/**
 * windows-acl 受限执行 runner：Provider 在调用方命令之前插入的那一层 argv 前缀。
 *
 * 它在**自己的进程里**创建 WRITE_RESTRICTED 受限令牌（restricting SID 列表 = logon SID +
 * Everyone + workspace/temp 能力 SID），用**继承的 stdio** 启动目标命令，原样镜像子进程的
 * 32 位退出码，然后退出。它不管理任何 DACL：能力 SID 的 ACE 由 Provider 在调用 runner **之前**
 * 落好并负责撤销（参见 `src/index.ts` 的职责切分），runner 只校验 argv 里的 SID 与路径一致。
 * `workspace-write` 下它还会把**自己进程**的 TMP/TEMP 指向 `--temp`（子进程继承 runner 的
 * 环境块），这样命令的临时写落在被授予的目录上，而不是撞上白名单。
 *
 * ## argv 契约
 *
 * ```text
 * [node, <runner>, '--workspace', <绝对目录>, '--temp', <绝对目录>,
 *  '--mode', <read-only|workspace-write>,
 *  ['--write-sid', <S-1-4-x-y>, '--temp-write-sid', <S-1-4-x-y-1>], '--', ...argv]
 * ```
 *
 * - `--workspace` / `--temp` 必给，且必须是已存在的绝对目录；
 * - `read-only` 不接受任何 SID 参数；
 * - `workspace-write` 两个 SID 必须同现，且分别等于 `workspaceWriteSid(workspace)` 与
 *   `tempWriteSid(temp)`（派生算法与本包 `src/workspace-sid.ts` 完全一致，有测试钉住）；
 * - 私有 temp 必须在 workspace 之外（否则 workspace 的继承性 ACE 会覆盖 temp 能力边界）。
 *
 * ## 为什么这个文件自包含
 *
 * Node 22 的类型剥离按原样解析 import 说明符：`./acl.js` **不会**映射到 `./acl.ts`，所以
 * runner 里不出现任何相对 import —— 它只依赖 `node:*`，并且只在需要时才解析 `koffi`。
 * 好处是「把 runner.ts 复制到别处、直接 `node runner.ts` 跑」真的可行（有测试覆盖），
 * 也保证了参数校验这类纯逻辑在任何平台、任何依赖状态下都不受 koffi 影响。代价是令牌层
 * 在这里保留一份与包内 ACL 层同形状的原生绑定（`RunnerBindings`），两边的公共成员签名
 * 由测试中的同一张假绑定表在编译期钉住。
 *
 * ## 失败契约
 *
 * 任何失败（参数、校验、令牌、spawn）都在 stderr 写一行 `windows-acl-run: <detail>` 并以
 * **127** 退出，绝不以非受限方式启动目标命令（fail closed）。正常路径返回子进程的退出码
 * （32 位全宽，不做任何截断）。
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** runner 侧失败信息的前缀（与 `src/index.ts` 的 `RUNNER_FAILURE_PREFIX` 一致）。 */
const RUNNER_FAILURE_PREFIX = 'windows-acl-run: '
/** runner 侧失败时的退出码（与 `src/index.ts` 的 `RUNNER_FAILURE_EXIT_CODE` 一致）。 */
const RUNNER_FAILURE_EXIT_CODE = 127

/* --------------------------- Win32 常量（就地一份） --------------------------- */

const ERROR_SUCCESS = 0
const PROCESS_QUERY_INFORMATION = 0x0400
const TOKEN_ASSIGN_PRIMARY = 0x0001
const TOKEN_DUPLICATE = 0x0002
const TOKEN_QUERY = 0x0008
const TOKEN_ADJUST_DEFAULT = 0x0080
const SE_GROUP_LOGON_ID = 0xC0000000
const TOKEN_GROUPS_INFO_CLASS = 2
const TOKEN_DEFAULT_DACL_INFO_CLASS = 6
const WIN_WORLD_SID = 1
const SECURITY_MAX_SID_SIZE = 68
const SID_AND_ATTRIBUTES_SIZE = 16
const TOKEN_GROUPS_OFFSET = 8
const GRANT_ACCESS = 1
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3
const NO_MULTIPLE_TRUSTEE = 0
const TRUSTEE_IS_SID = 0
const TRUSTEE_IS_UNKNOWN = 0
const EXPLICIT_ACCESS_W_SIZE = 48
const TRUSTEE_W_OFFSET = 16
const TRUSTEE_W_PTSTRNAME_OFFSET = 24
const FILE_ALL_ACCESS = 0x1F01FF
const DISABLE_MAX_PRIVILEGE = 0x1
const LUA_TOKEN = 0x4
const WRITE_RESTRICTED = 0x8
const STARTF_USESTDHANDLES = 0x00000100
const HANDLE_FLAG_INHERIT = 0x1
const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const STD_ERROR_HANDLE = -12
const CREATE_SUSPENDED = 0x4
// The runner itself has no visible console (a GUI host or windowsHide), so a
// console child would otherwise get a fresh, visible console window.
const CREATE_NO_WINDOW = 0x08000000
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS = 9
const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16
const INFINITE = 0xFFFFFFFF
const WAIT_FAILED = 0xFFFFFFFF
const STARTUPINFOW_SIZE = 104
const PROCESS_INFORMATION_SIZE = 24

/* --------------------------------- 公共类型 --------------------------------- */

/**
 * 原生指针：koffi 的 PVOID 是 64 位无符号整数，JS 侧用 `bigint` 表示，NULL 为 `0n`。
 *
 * 与 `src/ffi.ts` 的同名类型结构一致；runner 不能相对 import，因此就地声明。
 */
export type NativePtr = bigint

/** STARTUPINFOW 里本 runner 用到的字段。 */
export interface StartupInfoFields {
  cb: number
  dwFlags: number
  hStdInput: NativePtr
  hStdOutput: NativePtr
  hStdError: NativePtr
}

/** PROCESS_INFORMATION（`0n` 表示 NULL 句柄）。 */
export interface ProcessInfoFields {
  hProcess: NativePtr
  hThread: NativePtr
  dwProcessId: number
  dwThreadId: number
}

/**
 * runner 需要的一整张 Win32 绑定表。
 *
 * 形状与 `src/ffi.ts` 的 `Win32Api` 在公共成员上完全一致（多出令牌与进程创建部分），
 * 于是测试里的同一张假表既能喂给 ACL 层也能喂给令牌层，两边签名漂移会直接在编译期报错。
 */
export interface RunnerBindings {
  /* 内存与解码 */
  allocPtrSlot(): NativePtr
  allocUint32(): NativePtr
  allocBytes(length: number): NativePtr
  allocOverlapped(): NativePtr
  decodePtr(slot: NativePtr): NativePtr | null
  decodeUint32(slot: NativePtr): number
  encodeUint32(slot: NativePtr, value: number): void
  pointerAddress(ptr: NativePtr): bigint
  decodePtrAt(buffer: Buffer, offset: number): NativePtr | null
  decodeUint8At(ptr: NativePtr, offset: number): number
  decodeUint16At(ptr: NativePtr, offset: number): number
  decodeUint32At(ptr: NativePtr, offset: number): number
  /* 通用调用 */
  getLastError(): number
  formatMessageW(win32Code: number): string
  closeHandle(handle: NativePtr): number
  localFree(memory: NativePtr): NativePtr
  convertStringSidToSidW(stringSid: string, sidSlot: NativePtr): number
  /* 令牌 */
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  openProcessToken(process: NativePtr, desiredAccess: number, tokenSlot: NativePtr): number
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, sizeSlot: NativePtr): number
  isValidSid(sid: NativePtr): number
  getLengthSid(sid: NativePtr): number
  copySid(length: number, destination: NativePtr, source: NativePtr): number
  getTokenInformation(token: NativePtr, infoClass: number, info: Buffer | null, length: number, neededSlot: NativePtr): number
  setTokenInformation(token: NativePtr, infoClass: number, info: Buffer, length: number): number
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newTokenSlot: NativePtr,
  ): number
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAclSlot: NativePtr): number
  /* 进程创建与 Job */
  createProcessAsUserW(
    token: NativePtr,
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number
  getStdHandle(stdHandle: number): NativePtr
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number
  setConsoleCtrlHandler(handler: null, add: number): number
  createJobObjectW(attributes: null, name: null): NativePtr
  setInformationJobObject(job: NativePtr, infoClass: number, information: Buffer, length: number): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  resumeThread(thread: NativePtr): number
  terminateProcess(process: NativePtr, exitCode: number): number
  waitForSingleObject(handle: NativePtr, milliseconds: number): number
  getExitCodeProcess(process: NativePtr, exitCodeSlot: NativePtr): number
  allocStartupInfo(): NativePtr
  encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoFields): void
  allocProcessInfo(): NativePtr
  decodeProcessInfo(processInfo: NativePtr): ProcessInfoFields
}

/** 约束模式（自带，保持机制库不依赖 `@tnega/sandbox`）。 */
export type AclSandboxMode = 'read-only' | 'workspace-write'

/* ----------------------------------- 错误 ----------------------------------- */

/** 参数或校验失败：面向调用方，不带 Win32 错误码。 */
export class RunnerUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerUsageError'
  }
}

/** Win32 调用失败：带 API 名与精确错误码（与 `src/ffi.ts` 的 Win32Error 同形）。 */
export class Win32Error extends Error {
  readonly api: string
  readonly win32Code: number

  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'Win32Error'
    this.api = api
    this.win32Code = win32Code
  }
}

/** 指针是否为 NULL。 */
export function isNullPtr(value: NativePtr | null | undefined): boolean {
  return value === null || value === undefined || value === 0n
}

/**
 * 抛出当前 GetLastError 值。
 * @param api - 绑定表。
 * @param name - 失败的 Win32 操作名。
 * @param detail - 可选上下文。
 * @returns 永不返回。
 */
export function throwLastError(api: RunnerBindings, name: string, detail?: string): never {
  const win32Code = api.getLastError()
  throw new Win32Error(name, win32Code, detail ?? api.formatMessageW(win32Code))
}

/**
 * 抛出调用点已经捕获到的错误码（清理动作不能再覆盖它）。
 * @param api - 绑定表。
 * @param name - 失败的 Win32 操作名。
 * @param win32Code - 清理之前捕获的错误码。
 * @param detail - 可选上下文。
 * @returns 永不返回。
 */
export function throwWin32(api: RunnerBindings, name: string, win32Code: number, detail?: string): never {
  throw new Win32Error(name, win32Code, detail ?? api.formatMessageW(win32Code))
}

/* -------------------------- 纯逻辑：SID 派生与参数 -------------------------- */

/**
 * 派生 workspace 的写 SID。
 *
 * 算法必须与 `src/workspace-sid.ts` 的 {@link workspaceWriteSid} 逐位一致（测试钉住）：
 * 规范化路径的 sha256 前两个 u32 取 `% (2**30 - 1) + 1`。
 * @param workspace - 规范化后的 workspace 路径。
 * @returns SDDL 字符串。
 */
export function deriveWorkspaceWriteSid(workspace: string): string {
  const digest = createHash('sha256').update(workspace, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}`
}

/**
 * 派生私有 temp 目录的写 SID（第三个子授权号固定为 1，把 temp 身份与 workspace 身份在
 * 域上分开）。
 * @param temp - 私有 temp 目录的绝对路径。
 * @returns SDDL 字符串。
 */
export function deriveTempWriteSid(temp: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(temp, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}-1`
}

/** `root` 与 `candidate` 是同一个规范目录，或 root 包含 candidate。 */
function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate))
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/** 解析后的 runner 调用（`writeSid`/`tempWriteSid` 显式允许 undefined，避免条件对象）。 */
export interface ParsedRunnerInvocation {
  workspace: string
  temp: string
  mode: AclSandboxMode
  writeSid: string | undefined
  tempWriteSid: string | undefined
  command: string
  args: string[]
}

/**
 * 解析 argv（纯结构解析，不碰文件系统、不碰 koffi）。
 * @param raw - `process.argv.slice(2)` 形状的参数。
 * @returns 解析结果；结构不合法时抛 {@link RunnerUsageError}。
 */
export function parseRunnerArgs(raw: readonly string[]): ParsedRunnerInvocation {
  let workspace: string | undefined
  let temp: string | undefined
  let mode: string | undefined
  let writeSid: string | undefined
  let tempWriteSid: string | undefined
  let index = 0
  while (index < raw.length) {
    const token = raw[index]
    if (token === undefined) break
    if (token === '--') {
      index += 1
      break
    }
    const value = raw[index + 1]
    if (value === undefined) throw new RunnerUsageError(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      case '--temp-write-sid': tempWriteSid = value; break
      default: throw new RunnerUsageError(`unknown argument: ${token}`)
    }
    index += 2
  }
  if (workspace === undefined) throw new RunnerUsageError('missing --workspace')
  if (temp === undefined) throw new RunnerUsageError('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write') throw new RunnerUsageError(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) throw new RunnerUsageError('missing command after --')
  return { workspace, temp, mode, writeSid, tempWriteSid, command, args: argv.slice(1) }
}

/** 目录参数必须是已存在的绝对目录：相对路径的含义取决于 runner 的 cwd，边界不能随 cwd 漂移。 */
function requireAbsoluteDirectory(label: string, path: string): void {
  if (!isAbsolute(path)) throw new RunnerUsageError(`${label} must be an absolute path: ${path}`)
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new RunnerUsageError(`${label} is not an existing directory: ${path}`)
  }
}

/**
 * 校验解析结果（**在任何 koffi / 原生调用之前**执行）。
 *
 * 两条目录在两种模式下都要校验：Provider 传错根的 bug 必须在这里大声失败，而不是在子进程
 * 跑到一半时才暴露。
 * @param invocation - {@link parseRunnerArgs} 的结果。
 */
export function validateRunnerInvocation(invocation: ParsedRunnerInvocation): void {
  requireAbsoluteDirectory('--workspace', invocation.workspace)
  requireAbsoluteDirectory('--temp', invocation.temp)
  if (invocation.mode === 'read-only') {
    if (invocation.writeSid !== undefined || invocation.tempWriteSid !== undefined) {
      throw new RunnerUsageError('read-only must not carry --write-sid or --temp-write-sid')
    }
    return
  }
  if (invocation.writeSid === undefined || invocation.tempWriteSid === undefined) {
    throw new RunnerUsageError('workspace-write requires both --write-sid and --temp-write-sid')
  }
  const expectedWriteSid = deriveWorkspaceWriteSid(invocation.workspace)
  if (invocation.writeSid !== expectedWriteSid) {
    throw new RunnerUsageError(`--write-sid does not match --workspace (expected ${expectedWriteSid})`)
  }
  const expectedTempSid = deriveTempWriteSid(invocation.temp)
  if (invocation.tempWriteSid !== expectedTempSid) {
    throw new RunnerUsageError(`--temp-write-sid does not match --temp (expected ${expectedTempSid})`)
  }
  // 私有 temp 落在 workspace 内时，workspace 的继承性 ACE 会顺着目录继承进入 temp，
  // 两个能力的边界就合并了 —— 这里与 Provider 的 assertTempRootOutsideWorkspace 同义。
  if (containsDirectory(invocation.workspace, invocation.temp)) {
    throw new RunnerUsageError(
      `--temp must be outside --workspace: workspace=${invocation.workspace}; temp=${invocation.temp}`,
    )
  }
}

/**
 * 把 runner **自己进程**的 `TMP` / `TEMP` 指向私有 temp 目录（`workspace-write` 专属）。
 *
 * 为什么必须在 runner 里做：`lpEnvironment = NULL` 让子进程继承 runner 的**环境块**，所以只有
 * 改 runner 自己的环境才改得到子进程。不改的话，命令在工作区之外建临时文件时会失败得很奇怪
 * （写被 ACL 拒了，而报错来自某个中间层的临时文件）。`read-only` 保持原样：它没有任何能力
 * SID，temp 写本来就被拒，改与不改都不影响判定，而保留原环境更便于诊断。
 *
 * Node 在 Windows 上读写 `process.env` 会直接落到 `SetEnvironmentVariableW` /
 * `GetEnvironmentVariableW`，所以改的就是那块环境块。
 * @param mode - 本次执行的模式。
 * @param tempDir - Provider 已经授予并传入的私有 temp 目录（绝对路径）。
 */
export function applyPrivateTempEnvironment(mode: AclSandboxMode, tempDir: string): void {
  if (mode !== 'workspace-write') return
  process.env.TMP = tempDir
  process.env.TEMP = tempDir
}

/**
 * 按 CommandLineToArgvW 的解析规则给一个参数加引号。
 * @param argument - 一个 argv 项。
 * @returns 不加引号或加引号后的命令行片段。
 */
export function quoteArg(argument: string): string {
  if (argument === '') return '""'
  if (!/[\s"]/u.test(argument)) return argument
  let quoted = '"'
  for (let index = 0; index < argument.length; index += 1) {
    let backslashes = 0
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes += 1
      index += 1
    }
    if (index === argument.length) {
      quoted += '\\'.repeat(backslashes * 2)
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index)
    }
  }
  return quoted + '"'
}

/**
 * 判断 program 是否是 `cmd.exe`。
 *
 * 只比较路径最后一段，并去掉 `.exe`（大小写不敏感）：`cmd`、`cmd.exe`、
 * `C:\Windows\System32\CMD.EXE` 都算。
 * @param program - argv 第一项。
 * @returns 是 cmd 时为 true。
 */
function isCmdProgram(program: string): boolean {
  const base = program.split(/[\\/]/u).pop() ?? ''
  const withoutExtension = base.toLowerCase().endsWith('.exe') ? base.slice(0, -'.exe'.length) : base
  return withoutExtension.toLowerCase() === 'cmd'
}

/** cmd 的命令开关：其后紧跟「整条命令」。 */
const CMD_COMMAND_SWITCHES = new Set(['/c', '/k'])

/**
 * 拼出 CreateProcessAsUserW 需要的可变命令行。
 *
 * **cmd.exe 是特例**：它不按 CRT/CommandLineToArgvW 规则解析 `/c`、`/k` 之后的文本，而是逐字
 * 交给自己的命令解释器（`\"` 会原样留在命令里、重定向符会被引号包住而失效）。所以遇到
 * `cmd` 时，程序名与 `/c`（或 `/k`）之前的开关仍按 CRT 规则加引号，命令部分则**按原样**包进
 * 一对引号，交给 cmd 的 `/s` 语义剥掉外层引号后逐字执行——这也是 Node 的 `shell: true` 的构造
 * 方式。命令本身以引号开头（例如 `cmd /c "C:\Program Files\a.exe" --x`）同样正确：`/s` 剥掉的
 * 正是我们加的那一对。
 *
 * cmd 之外（bash / pwsh / node / rg …）保持完整的 CRT 引号规则。
 * @param program - argv 第一项（可执行文件）。
 * @param args - 其余参数。
 * @returns Win32 命令行。
 */
export function buildCommandLine(program: string, args: readonly string[]): string {
  if (isCmdProgram(program)) {
    const switchIndex = args.findIndex(argument => CMD_COMMAND_SWITCHES.has(argument.toLowerCase()))
    if (switchIndex >= 0) {
      const switches = [program, ...args.slice(0, switchIndex + 1)].map(quoteArg).join(' ')
      // 命令按原样拼接：这一段的引号/重定向必须留给 cmd 自己解析。
      return `${switches} "${args.slice(switchIndex + 1).join(' ')}"`
    }
  }
  return [program, ...args].map(quoteArg).join(' ')
}

/* ------------------------------- koffi 惰性加载 ------------------------------- */

/** koffi 类型描述符。 */
interface KoffiType {
  readonly size: number
}
/** 已加载的 DLL。 */
interface KoffiLibrary {
  func(
    convention: string,
    name: string,
    result: KoffiType | string,
    args: readonly (KoffiType | string)[],
  ): (...args: readonly unknown[]) => unknown
}
/** 本 runner 用到的 koffi 表面。 */
export interface KoffiModule {
  load(library: string): KoffiLibrary
  pointer(type: KoffiType | string): KoffiType
  struct(name: string, members: Record<string, KoffiType | string>): KoffiType
  alloc(type: KoffiType | string, count: number): unknown
  decode(value: unknown, offsetOrType: number | KoffiType | string, type?: KoffiType | string): unknown
  encode(target: unknown, typeOrOffset: KoffiType | string | number, value: unknown): void
  address(pointer: unknown): unknown
}

function isKoffiModule(value: unknown): value is KoffiModule {
  if (typeof value !== 'object' || value === null) return false
  return ['load', 'pointer', 'struct', 'alloc', 'decode', 'encode', 'address']
    .every(name => typeof Reflect.get(value, name) === 'function')
}

/** 把一个 koffi 返回值收敛成指针（NULL 归一为 0n）。 */
function asPointer(value: unknown, api: string): NativePtr {
  if (value === null || value === undefined) return 0n
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
  throw new Error(`koffi returned a non-pointer from ${api}`)
}

/** 把一个 koffi 返回值收敛成数字。 */
function asNumber(value: unknown, api: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error(`koffi returned a non-number from ${api}`)
}

/**
 * 解析 koffi。
 *
 * 说明符故意写成变量：编译期不为 `koffi` 做模块解析，于是参数校验这类纯逻辑在没有 koffi
 * 的宿主上也完全可用；真正的原生库解析推迟到这一刻（校验之后）。
 * @returns 通过形状校验的 koffi 模块。
 */
export async function loadKoffi(): Promise<KoffiModule> {
  const specifier = 'koffi'
  let loaded: unknown
  try {
    loaded = await import(specifier)
  } catch (error) {
    throw new Error(
      `could not load koffi: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const candidate: unknown = typeof loaded === 'object' && loaded !== null && 'default' in loaded
    ? Reflect.get(loaded, 'default')
    : loaded
  if (!isKoffiModule(candidate)) {
    throw new Error('koffi loaded but its export shape is unusable (load/pointer/struct/alloc/decode/encode/address missing)')
  }
  return candidate
}

/** 用 koffi 构造 runner 的真实绑定表。 */
export function createRunnerBindings(koffi: KoffiModule): RunnerBindings {
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const PVOID = koffi.pointer('void')
  const PPVOID = koffi.pointer(PVOID)
  const PUINT32 = koffi.pointer('uint32')
  const bind = (
    library: KoffiLibrary,
    name: string,
    result: KoffiType | string,
    args: readonly (KoffiType | string)[],
  ): ((...callArgs: readonly unknown[]) => unknown) => library.func('__stdcall', name, result, args)

  const STARTUPINFOW = koffi.struct('TNEGA_WINDOWS_ACL_STARTUPINFOW', {
    cb: 'uint32',
    lpReserved: 'str16',
    lpDesktop: 'str16',
    lpTitle: 'str16',
    dwX: 'uint32',
    dwY: 'uint32',
    dwXSize: 'uint32',
    dwYSize: 'uint32',
    dwXCountChars: 'uint32',
    dwYCountChars: 'uint32',
    dwFillAttribute: 'uint32',
    dwFlags: 'uint32',
    wShowWindow: 'uint16',
    cbReserved2: 'uint16',
    lpReserved2: koffi.pointer('uint8'),
    hStdInput: PVOID,
    hStdOutput: PVOID,
    hStdError: PVOID,
  })
  const PROCESS_INFORMATION = koffi.struct('TNEGA_WINDOWS_ACL_PROCESS_INFORMATION', {
    hProcess: PVOID,
    hThread: PVOID,
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  })
  // 结构体布局一旦漂移，spawn 会静默传错参数（而不是报错）——宁可在这里大声失败。
  if (STARTUPINFOW.size !== STARTUPINFOW_SIZE || PROCESS_INFORMATION.size !== PROCESS_INFORMATION_SIZE) {
    throw new Error(
      `Win32 struct layout mismatch: STARTUPINFOW=${STARTUPINFOW.size} (expected ${STARTUPINFOW_SIZE}), `
      + `PROCESS_INFORMATION=${PROCESS_INFORMATION.size} (expected ${PROCESS_INFORMATION_SIZE})`,
    )
  }

  const closeHandle = bind(kernel32, 'CloseHandle', 'int', [PVOID])
  const getLastError = bind(kernel32, 'GetLastError', 'uint32', [])
  const localFree = bind(kernel32, 'LocalFree', PVOID, [PVOID])
  const convertStringSidToSidW = bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID])
  const openProcess = bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32'])
  const openProcessToken = bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID])
  const createWellKnownSid = bind(advapi32, 'CreateWellKnownSid', 'int', ['int', PVOID, PVOID, PUINT32])
  const isValidSid = bind(advapi32, 'IsValidSid', 'int', [PVOID])
  const getLengthSid = bind(advapi32, 'GetLengthSid', 'uint32', [PVOID])
  const copySid = bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID])
  const getTokenInformation = bind(advapi32, 'GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', PUINT32])
  const setTokenInformation = bind(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32'])
  const createRestrictedToken = bind(advapi32, 'CreateRestrictedToken', 'int', [
    PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID,
  ])
  const setEntriesInAclW = bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID])
  const createProcessAsUserW = bind(advapi32, 'CreateProcessAsUserW', 'int', [
    PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
    koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
  ])
  const getStdHandle = bind(kernel32, 'GetStdHandle', PVOID, ['int'])
  const setHandleInformation = bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32'])
  const setConsoleCtrlHandler = bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int'])
  const createJobObjectW = bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16'])
  const setInformationJobObject = bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32'])
  const assignProcessToJobObject = bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID])
  const resumeThread = bind(kernel32, 'ResumeThread', 'uint32', [PVOID])
  const terminateProcess = bind(kernel32, 'TerminateProcess', 'int', [PVOID, 'uint32'])
  const waitForSingleObject = bind(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32'])
  const getExitCodeProcess = bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, PUINT32])

  return {
    allocPtrSlot: () => asPointer(koffi.alloc(PVOID, 1), 'alloc'),
    allocUint32: () => asPointer(koffi.alloc('uint32', 1), 'alloc'),
    allocBytes: (length: number) => asPointer(koffi.alloc('uint8', length), 'alloc'),
    allocOverlapped: () => asPointer(koffi.alloc('uint8', 32), 'alloc'),
    decodePtr: (slot: NativePtr) => {
      const value = asPointer(koffi.decode(slot, 0, PVOID), 'decode')
      return value === 0n ? null : value
    },
    decodeUint32: (slot: NativePtr) => asNumber(koffi.decode(slot, 0, 'uint32'), 'decode'),
    encodeUint32: (slot: NativePtr, value: number) => { koffi.encode(slot, 'uint32', value) },
    pointerAddress: (ptr: NativePtr) => asPointer(koffi.address(ptr), 'address'),
    decodePtrAt: (buffer: Buffer, offset: number) => {
      const value = asPointer(koffi.decode(buffer, offset, PVOID), 'decode')
      return value === 0n ? null : value
    },
    decodeUint8At: (ptr: NativePtr, offset: number) => asNumber(koffi.decode(ptr, offset, 'uint8'), 'decode'),
    decodeUint16At: (ptr: NativePtr, offset: number) => asNumber(koffi.decode(ptr, offset, 'uint16'), 'decode'),
    decodeUint32At: (ptr: NativePtr, offset: number) => asNumber(koffi.decode(ptr, offset, 'uint32'), 'decode'),
    getLastError: () => asNumber(getLastError(), 'GetLastError'),
    formatMessageW: (win32Code: number) => {
      const formatMessageW = bind(kernel32, 'FormatMessageW', 'uint32', [
        'uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID,
      ])
      const buffer = Buffer.alloc(1024)
      const length = asNumber(
        formatMessageW(0x00001000 | 0x00000200, null, win32Code, 0, buffer, buffer.length / 2, null),
        'FormatMessageW',
      )
      return length === 0 ? '' : buffer.subarray(0, length * 2).toString('utf16le').trim()
    },
    closeHandle: (handle: NativePtr) => asNumber(closeHandle(handle), 'CloseHandle'),
    localFree: (memory: NativePtr) => asPointer(localFree(memory), 'LocalFree'),
    convertStringSidToSidW: (stringSid: string, sidSlot: NativePtr) =>
      asNumber(convertStringSidToSidW(stringSid, sidSlot), 'ConvertStringSidToSidW'),
    openProcess: (desiredAccess: number, inheritHandle: number, pid: number) =>
      asPointer(openProcess(desiredAccess, inheritHandle, pid), 'OpenProcess'),
    openProcessToken: (process: NativePtr, desiredAccess: number, tokenSlot: NativePtr) =>
      asNumber(openProcessToken(process, desiredAccess, tokenSlot), 'OpenProcessToken'),
    createWellKnownSid: (type: number, domainSid: null, sid: NativePtr, sizeSlot: NativePtr) =>
      asNumber(createWellKnownSid(type, domainSid, sid, sizeSlot), 'CreateWellKnownSid'),
    isValidSid: (sid: NativePtr) => asNumber(isValidSid(sid), 'IsValidSid'),
    getLengthSid: (sid: NativePtr) => asNumber(getLengthSid(sid), 'GetLengthSid'),
    copySid: (length: number, destination: NativePtr, source: NativePtr) =>
      asNumber(copySid(length, destination, source), 'CopySid'),
    getTokenInformation: (token: NativePtr, infoClass: number, info: Buffer | null, length: number, neededSlot: NativePtr) =>
      asNumber(getTokenInformation(token, infoClass, info, length, neededSlot), 'GetTokenInformation'),
    setTokenInformation: (token: NativePtr, infoClass: number, info: Buffer, length: number) =>
      asNumber(setTokenInformation(token, infoClass, info, length), 'SetTokenInformation'),
    createRestrictedToken: (
      existing: NativePtr,
      flags: number,
      disableCount: number,
      disableSids: null,
      deletePrivilegeCount: number,
      privilegesToDelete: null,
      restrictCount: number,
      restrictingSids: Buffer,
      newTokenSlot: NativePtr,
    ) => asNumber(
      createRestrictedToken(
        existing, flags, disableCount, disableSids, deletePrivilegeCount, privilegesToDelete,
        restrictCount, restrictingSids, newTokenSlot,
      ),
      'CreateRestrictedToken',
    ),
    setEntriesInAclW: (count: number, entries: Buffer, oldAcl: NativePtr | null, newAclSlot: NativePtr) =>
      asNumber(setEntriesInAclW(count, entries, oldAcl, newAclSlot), 'SetEntriesInAclW'),
    createProcessAsUserW: (
      token: NativePtr,
      applicationName: string | null,
      commandLine: string,
      processAttributes: null,
      threadAttributes: null,
      inheritHandles: number,
      creationFlags: number,
      environment: null,
      currentDirectory: string | null,
      startupInfo: NativePtr,
      processInfo: NativePtr,
    ) => asNumber(
      createProcessAsUserW(
        token, applicationName, commandLine, processAttributes, threadAttributes, inheritHandles,
        creationFlags, environment, currentDirectory, startupInfo, processInfo,
      ),
      'CreateProcessAsUserW',
    ),
    getStdHandle: (stdHandle: number) => asPointer(getStdHandle(stdHandle), 'GetStdHandle'),
    setHandleInformation: (handle: NativePtr, mask: number, flags: number) =>
      asNumber(setHandleInformation(handle, mask, flags), 'SetHandleInformation'),
    setConsoleCtrlHandler: (handler: null, add: number) => asNumber(setConsoleCtrlHandler(handler, add), 'SetConsoleCtrlHandler'),
    createJobObjectW: (attributes: null, name: null) => asPointer(createJobObjectW(attributes, name), 'CreateJobObjectW'),
    setInformationJobObject: (job: NativePtr, infoClass: number, information: Buffer, length: number) =>
      asNumber(setInformationJobObject(job, infoClass, information, length), 'SetInformationJobObject'),
    assignProcessToJobObject: (job: NativePtr, process: NativePtr) =>
      asNumber(assignProcessToJobObject(job, process), 'AssignProcessToJobObject'),
    resumeThread: (thread: NativePtr) => asNumber(resumeThread(thread), 'ResumeThread'),
    terminateProcess: (process: NativePtr, exitCode: number) =>
      asNumber(terminateProcess(process, exitCode), 'TerminateProcess'),
    waitForSingleObject: (handle: NativePtr, milliseconds: number) =>
      asNumber(waitForSingleObject(handle, milliseconds), 'WaitForSingleObject'),
    getExitCodeProcess: (process: NativePtr, exitCodeSlot: NativePtr) =>
      asNumber(getExitCodeProcess(process, exitCodeSlot), 'GetExitCodeProcess'),
    allocStartupInfo: () => asPointer(koffi.alloc(STARTUPINFOW, 1), 'alloc'),
    encodeStartupInfo: (startupInfo: NativePtr, fields: StartupInfoFields) => {
      koffi.encode(startupInfo, STARTUPINFOW, fields)
    },
    allocProcessInfo: () => asPointer(koffi.alloc(PROCESS_INFORMATION, 1), 'alloc'),
    decodeProcessInfo: (processInfo: NativePtr) => {
      const decoded = koffi.decode(processInfo, PROCESS_INFORMATION)
      if (typeof decoded !== 'object' || decoded === null) throw new Error('koffi returned a non-struct from PROCESS_INFORMATION')
      return {
        hProcess: asPointer(Reflect.get(decoded, 'hProcess'), 'PROCESS_INFORMATION.hProcess'),
        hThread: asPointer(Reflect.get(decoded, 'hThread'), 'PROCESS_INFORMATION.hThread'),
        dwProcessId: asNumber(Reflect.get(decoded, 'dwProcessId'), 'PROCESS_INFORMATION.dwProcessId'),
        dwThreadId: asNumber(Reflect.get(decoded, 'dwThreadId'), 'PROCESS_INFORMATION.dwThreadId'),
      }
    },
  }
}

/** 解析 koffi 并构造绑定表（唯一的原生入口）。 */
export async function loadRunnerBindings(): Promise<RunnerBindings> {
  return createRunnerBindings(await loadKoffi())
}

/* --------------------------------- 受限令牌 --------------------------------- */

/** 构造受限令牌所需的输入。 */
export interface RestrictedTokenOptions {
  mode: AclSandboxMode
  /** workspace 能力 SID（read-only 下必须缺席）。 */
  writeSid: string | undefined
  /** 私有 temp 能力 SID（read-only 下必须缺席）。 */
  tempWriteSid: string | undefined
}

/** 释放一块原生分配；失败被忽略（见调用点的说明）。 */
function releaseAllocation(api: RunnerBindings, memory: NativePtr | undefined): void {
  if (memory === undefined || isNullPtr(memory)) return
  api.localFree(memory)
}

/** 解析一个 SID 字符串（失败即抛，带 API 名与错误码）。 */
function parseSidString(api: RunnerBindings, sid: string): NativePtr {
  const slot = api.allocPtrSlot()
  if (api.convertStringSidToSidW(sid, slot) === 0) throwLastError(api, 'ConvertStringSidToSidW', sid)
  const parsed = api.decodePtr(slot)
  if (parsed === null) throwWin32(api, 'ConvertStringSidToSidW', api.getLastError(), `null SID for ${sid}`)
  return parsed
}

/**
 * 打开当前进程的访问令牌，并取到 CreateRestrictedToken 需要的权限。
 *
 * 通过真实的 OpenProcess 句柄拿令牌（`GetCurrentProcess()` 的伪句柄在 koffi 里不可寻址）。
 * @param api - 绑定表。
 * @returns 打开的令牌句柄（调用方负责关闭）。
 */
export function openCurrentProcessToken(api: RunnerBindings): NativePtr {
  const processHandle = api.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)

  const tokenSlot = api.allocPtrSlot()
  const opened = api.openProcessToken(
    processHandle,
    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  )
  if (opened === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(processHandle) // 错误路径上的尽力清理
    throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`)
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle')
  const token = api.decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle')
  return token
}

/**
 * 找到并复制令牌的 logon session SID（`S-1-5-5-x-y`，属性位 SE_GROUP_LOGON_ID）。
 *
 * 受限令牌需要它才能访问 WinSta0/桌面等「每次登录」对象；没有它，早期 DLL 初始化会以
 * 0xC0000142 失败。
 * @param api - 绑定表。
 * @param token - 被扫描的令牌。
 * @returns 复制出来的 logon SID（令牌里没有则抛）。
 */
export function findLogonSid(api: RunnerBindings, token: NativePtr): NativePtr {
  const neededSlot = api.allocUint32()
  api.getTokenInformation(token, TOKEN_GROUPS_INFO_CLASS, null, 0, neededSlot) // 预期以 ERROR_INSUFFICIENT_BUFFER 失败
  const needed = api.decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenGroups size query')
  if (needed < TOKEN_GROUPS_OFFSET) {
    throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`)
  }

  const groups = Buffer.alloc(needed)
  if (api.getTokenInformation(token, TOKEN_GROUPS_INFO_CLASS, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups')
  }
  const groupCount = groups.readUInt32LE(0)
  for (let index = 0; index < groupCount; index += 1) {
    const sidPtr = api.decodePtrAt(groups, TOKEN_GROUPS_OFFSET + index * SID_AND_ATTRIBUTES_SIZE)
    const attributes = groups.readUInt32LE(TOKEN_GROUPS_OFFSET + index * SID_AND_ATTRIBUTES_SIZE + 8)
    // >>> 0：JS 的按位 & 是带符号 32 位，而 SE_GROUP_LOGON_ID 的最高位是 1。
    const isLogonId = ((attributes & SE_GROUP_LOGON_ID) >>> 0) === (SE_GROUP_LOGON_ID >>> 0)
    if (sidPtr === null || !isLogonId) continue
    const sidLength = api.getLengthSid(sidPtr)
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', `logon SID group ${index}`)
    const copy = api.allocBytes(sidLength)
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', `logon SID group ${index}`)
    return copy
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`)
}

/**
 * 创建一个众所周知的 SID（68 字节缓冲）并断言它有效。
 * @param api - 绑定表。
 * @param type - WELL_KNOWN_SID_TYPE。
 * @returns 创建出来的 SID。
 */
export function makeWellKnownSid(api: RunnerBindings, type: number): NativePtr {
  const sid = api.allocBytes(SECURITY_MAX_SID_SIZE)
  const sizeSlot = api.allocUint32()
  api.encodeUint32(sizeSlot, SECURITY_MAX_SID_SIZE)
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, 'CreateWellKnownSid', `type ${type}`)
  }
  if (api.isValidSid(sid) === 0) throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`)
  return sid
}

/** 打包一条 EXPLICIT_ACCESS_W（布局与 `src/acl.ts` 的 buildExplicitAccess 相同）。 */
function packExplicitAccess(api: RunnerBindings, sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0)
  entry.writeUInt32LE(mode, 4)
  entry.writeUInt32LE(SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8)
  entry.writeUInt32LE(NO_MULTIPLE_TRUSTEE, TRUSTEE_W_OFFSET + 8)
  entry.writeUInt32LE(TRUSTEE_IS_SID, TRUSTEE_W_OFFSET + 12)
  entry.writeUInt32LE(TRUSTEE_IS_UNKNOWN, TRUSTEE_W_OFFSET + 16)
  entry.writeBigUInt64LE(api.pointerAddress(sidPtr), TRUSTEE_W_OFFSET + TRUSTEE_W_PTSTRNAME_OFFSET)
  return entry
}

/**
 * 往受限令牌的 DEFAULT DACL 里合并一条「restricting SID 全权」ACE。
 *
 * 为什么必须有这一步：受限令牌会原样继承用户的默认 DACL，而默认 DACL 里没有任何
 * restricting SID。于是受限进程新建对象（匿名管道、同步对象）时，写 pass-2 检查在这个
 * **新对象的 DACL** 上找不到白名单 SID，创建直接 ERROR_ACCESS_DENIED（Node 表面上是
 * spawn EPERM）——受限进程内用 libuv 命名管道 spawn 孙进程就会失败。合并一条指向
 * restricting SID 的全权 ACE 后，新对象自身的 DACL 能通过 pass-2，而对象**创建**本身仍
 * 受父容器 DACL 约束（未被授予的树依然创建不出来）。选 temp SID 优先：这样默认 DACL
 * 对象不会顺手拿到共享的 workspace 能力。
 * @param api - 绑定表。
 * @param token - 被调整的受限令牌（需要 TOKEN_ADJUST_DEFAULT）。
 * @param sidPtr - 进入默认 DACL 的 restricting SID。
 */
export function setTokenDefaultDaclGrant(api: RunnerBindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = api.allocUint32()
  api.getTokenInformation(token, TOKEN_DEFAULT_DACL_INFO_CLASS, null, 0, neededSlot) // 预期缓冲区不足
  const needed = api.decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl size query')
  const buffer = Buffer.alloc(needed)
  if (api.getTokenInformation(token, TOKEN_DEFAULT_DACL_INFO_CLASS, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl')
  }
  const currentDacl = api.decodePtrAt(buffer, 0)
  if (currentDacl === null) throw new Error('setTokenDefaultDaclGrant: the token carries no default DACL to extend')

  const newDaclSlot = api.allocPtrSlot()
  const result = api.setEntriesInAclW(1, packExplicitAccess(api, sidPtr, GRANT_ACCESS, FILE_ALL_ACCESS), currentDacl, newDaclSlot)
  if (result !== ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', result, 'default DACL merge')
  const newDacl = api.decodePtr(newDaclSlot)
  if (newDacl === null) throwWin32(api, 'SetEntriesInAclW', result, 'null merged default DACL')
  // TOKEN_DEFAULT_DACL { PACL DefaultDacl; } —— 结构体就是这个指针本身，
  // SetTokenInformation 会在返回前复制 ACL。
  const info = Buffer.alloc(8)
  info.writeBigUInt64LE(newDacl, 0)
  if (api.setTokenInformation(token, TOKEN_DEFAULT_DACL_INFO_CLASS, info, info.length) === 0) {
    const win32Code = api.getLastError()
    api.localFree(newDacl)
    throwWin32(api, 'SetTokenInformation', win32Code, 'TokenDefaultDacl')
  }
  api.localFree(newDacl)
}

/** 打包 SID_AND_ATTRIBUTES 数组（16 字节跨度，Attributes 保持 0）。 */
function packRestrictingSids(api: RunnerBindings, sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(SID_AND_ATTRIBUTES_SIZE * sids.length)
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(api.pointerAddress(sid), SID_AND_ATTRIBUTES_SIZE * index)
  })
  return buffer
}

/**
 * 创建受限令牌。
 *
 * restricting 列表按模式选择：
 *
 * - `read-only`：`[logon SID, Everyone]`——没有能力 SID，因此早先 workspace-write 时期留下
 *   的常驻授予 ACE 在 read-only 下完全**惰性**（pass-2 只认 restricting 列表里有的东西）。
 * - `workspace-write`：`[logon SID, Everyone, workspace 能力 SID, temp 能力 SID]`。
 *
 * 两种模式都保留 `logon SID + Everyone` 这组「保活」SID：缺了它们，早期 DLL 初始化会以
 * 0xC0000142 死掉，CNG（pwsh）也会崩。Authenticated Users 与 INTERACTIVE/LOCAL 两种模式下
 * 都**不在**列表里——这是 CIM/WMI 不可用与 Public 树写被拒的来源，写在 README 的限制清单里。
 *
 * fail-closed：任何失败都抛出，绝不返回非受限令牌。
 * @param api - 绑定表。
 * @param options - 模式与两个能力 SID。
 * @returns 受限令牌句柄（调用方负责关闭）。
 */
export function createRestrictedSandboxToken(api: RunnerBindings, options: RestrictedTokenOptions): NativePtr {
  const currentToken = openCurrentProcessToken(api)
  const allocations: NativePtr[] = []
  let restrictedToken: NativePtr | undefined
  let failed = false
  try {
    const writeSids: NativePtr[] = []
    if (options.writeSid !== undefined) {
      const writeSidPtr = parseSidString(api, options.writeSid)
      allocations.push(writeSidPtr)
      writeSids.push(writeSidPtr)
    }
    if (options.tempWriteSid !== undefined) {
      const tempSidPtr = parseSidString(api, options.tempWriteSid)
      allocations.push(tempSidPtr)
      writeSids.push(tempSidPtr)
    }
    if (options.mode === 'workspace-write' && writeSids.length === 0) {
      throw new RunnerUsageError('workspace-write restricting list requires at least one write SID')
    }
    const logonSid = findLogonSid(api, currentToken)
    allocations.push(logonSid)
    const worldSid = makeWellKnownSid(api, WIN_WORLD_SID)
    allocations.push(worldSid)

    const restricting = options.mode === 'read-only' ? [logonSid, worldSid] : [logonSid, worldSid, ...writeSids]
    const tokenSlot = api.allocPtrSlot()
    const created = api.createRestrictedToken(
      currentToken,
      DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
      0, null, // 不禁用任何 SID
      0, null, // 不删除任何特权
      restricting.length,
      packRestrictingSids(api, restricting),
      tokenSlot,
    )
    if (created === 0) throwLastError(api, 'CreateRestrictedToken', `${restricting.length} restricting SID(s)`)
    const token = api.decodePtr(tokenSlot)
    if (token === null) throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle')
    restrictedToken = token
    setTokenDefaultDaclGrant(api, token, writeSids.at(-1) ?? worldSid)
    return token
  } catch (error) {
    failed = true
    throw error
  } finally {
    // 这些原生内存（能力 SID、logon SID、众所周知的 SID）在成功与失败路径上都不再需要：
    // CreateRestrictedToken 已经复制了它们。清理失败不覆盖主错误——runner 马上要么继续跑
    // 子进程，要么以 127 退出，泄漏的句柄由进程退出回收。
    for (const memory of allocations) releaseAllocation(api, memory)
    api.closeHandle(currentToken)
    if (failed && restrictedToken !== undefined) api.closeHandle(restrictedToken)
  }
}

/* ------------------------------ 进程创建与等待 ------------------------------ */

/** 运行中的受限子进程：进程句柄、Job 句柄与 pid。 */
export interface RestrictedChildProcess {
  pid: number
  process: NativePtr
  job: NativePtr
}

/** 标准句柄三元组。 */
interface StandardHandles {
  stdin: NativePtr
  stdout: NativePtr
  stderr: NativePtr
}

/** 建一个 KILL_ON_JOB_CLOSE 的 Job：runner 被杀死时子进程跟着消失。 */
function createKillOnCloseJob(api: RunnerBindings): NativePtr {
  const job = api.createJobObjectW(null, null)
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW')
  const information = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE)
  information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
  if (api.setInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS, information, information.length) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(job)
    throwWin32(api, 'SetInformationJobObject', win32Code)
  }
  return job
}

/** 取 runner 自己的标准句柄。 */
function inheritedStandardHandles(api: RunnerBindings): StandardHandles {
  const get = (selector: number, label: string): NativePtr => {
    const handle = api.getStdHandle(selector)
    if (!isNullPtr(handle)) return handle
    throwLastError(api, 'GetStdHandle', `null ${label} handle`)
  }
  return {
    stdin: get(STD_INPUT_HANDLE, 'stdin'),
    stdout: get(STD_OUTPUT_HANDLE, 'stdout'),
    stderr: get(STD_ERROR_HANDLE, 'stderr'),
  }
}

/**
 * 以受限令牌启动目标命令，stdio **继承** runner 自己的句柄（字节直接流过，不做管道轮询）。
 *
 * 顺序是安全关键的：CREATE_SUSPENDED 创建 → 放进 KILL_ON_JOB_CLOSE 的 Job → ResumeThread。
 * 任何一步失败都终止已创建的子进程并抛错，绝不放一个不受 Job 约束、也可能已经跑起来的
 * 子进程出去。
 *
 * `lpEnvironment = NULL`：子进程继承 runner 自己的环境块（koffi 传显式环境块会让
 * CreateProcessAsUserW 以 ERROR_INVALID_PARAMETER 失败）。cwd 用 runner 的 cwd——上层执行
 * 边界在启动 runner 时就设好了工作目录。
 * @param api - 绑定表。
 * @param token - 受限主令牌。
 * @param options - 命令行、参数与工作目录。
 * @returns 已经 resume 的子进程句柄。
 */
export function spawnRestrictedInherited(
  api: RunnerBindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): RestrictedChildProcess {
  const job = createKillOnCloseJob(api)
  // Node 启动时会清掉自己的 stdio 继承位（uv_disable_stdio_inheritance），
  // STARTF_USESTDHANDLES 要求它们重新可继承；用完立刻还原（尽力而为）。
  const enabled: NativePtr[] = []
  try {
    const stdio = inheritedStandardHandles(api)
    for (const [handle, label] of [
      [stdio.stdin, 'stdin'],
      [stdio.stdout, 'stdout'],
      [stdio.stderr, 'stderr'],
    ] as const) {
      if (api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, 'SetHandleInformation', `${label} (enable inherit)`)
      }
      enabled.push(handle)
    }
    const startupInfo = api.allocStartupInfo()
    api.encodeStartupInfo(startupInfo, {
      cb: STARTUPINFOW_SIZE,
      dwFlags: STARTF_USESTDHANDLES,
      hStdInput: stdio.stdin,
      hStdOutput: stdio.stdout,
      hStdError: stdio.stderr,
    })
    const processInfo = api.allocProcessInfo()
    const created = api.createProcessAsUserW(
      token,
      null,
      buildCommandLine(options.command, options.args),
      null,
      null,
      1,
      CREATE_SUSPENDED | CREATE_NO_WINDOW,
      null,
      options.cwd,
      startupInfo,
      processInfo,
    )
    if (created === 0) {
      throwWin32(api, 'CreateProcessAsUserW', api.getLastError(), `command: ${options.command}, cwd: ${options.cwd}`)
    }
    const info = api.decodeProcessInfo(processInfo)
    if (isNullPtr(info.hProcess) || isNullPtr(info.hThread)) {
      api.terminateProcess(info.hProcess, 1)
      if (!isNullPtr(info.hThread)) api.closeHandle(info.hThread)
      if (!isNullPtr(info.hProcess)) api.closeHandle(info.hProcess)
      throw new Error(`CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`)
    }
    if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
      const win32Code = api.getLastError()
      api.terminateProcess(info.hProcess, 1)
      api.closeHandle(info.hThread)
      api.closeHandle(info.hProcess)
      throwWin32(api, 'AssignProcessToJobObject', win32Code, `pid ${info.dwProcessId}`)
    }
    if (api.resumeThread(info.hThread) === 0xFFFFFFFF) {
      const win32Code = api.getLastError()
      api.terminateProcess(info.hProcess, 1)
      api.closeHandle(info.hThread)
      api.closeHandle(info.hProcess)
      throwWin32(api, 'ResumeThread', win32Code, `pid ${info.dwProcessId}`)
    }
    api.closeHandle(info.hThread)
    return { pid: info.dwProcessId, process: info.hProcess, job }
  } catch (error) {
    // 失败路径上 Job 还没有交出去（成功路径直接 return，不会走到这里）：
    // 关掉它 = KILL_ON_JOB_CLOSE，任何已经创建出来的子进程都不会逃出 Job 约束。
    api.closeHandle(job)
    throw error
  } finally {
    for (const handle of enabled) api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)
  }
}

/**
 * 等待受限子进程结束并读回它的退出码，随后关闭进程与 Job 句柄。
 *
 * 退出码按 32 位全宽返回（`GetExitCodeProcess` 给的就是 uint32），调用方原样镜像即可。
 * @param api - 绑定表。
 * @param child - {@link spawnRestrictedInherited} 的结果。
 * @returns 子进程的直接退出码。
 */
export function waitForRestrictedExit(api: RunnerBindings, child: RestrictedChildProcess): number {
  try {
    if (api.waitForSingleObject(child.process, INFINITE) === WAIT_FAILED) {
      throwLastError(api, 'WaitForSingleObject', `pid ${child.pid}`)
    }
    const exitCodeSlot = api.allocUint32()
    if (api.getExitCodeProcess(child.process, exitCodeSlot) === 0) {
      throwLastError(api, 'GetExitCodeProcess', `pid ${child.pid}`)
    }
    return api.decodeUint32(exitCodeSlot)
  } finally {
    // 子进程已经结束（或等待本身失败）：进程与 Job 句柄一次都不再需要。
    // Job 关闭即 KILL_ON_JOB_CLOSE，子进程可能留下的后台子进程也跟着消失。
    api.closeHandle(child.process)
    api.closeHandle(child.job)
  }
}

/* ---------------------------------- 入口 ---------------------------------- */

/** 本模块的绝对路径：优先 import.meta.filename，退回 fileURLToPath(import.meta.url)。 */
function modulePath(): string {
  const meta: ImportMeta & { filename?: string } = import.meta
  return typeof meta.filename === 'string' ? meta.filename : fileURLToPath(import.meta.url)
}

/** 是否由 `node <runner.ts>` 直接执行（被 import 时绝不启动 main，也绝不加载 koffi）。 */
function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const normalize = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  return normalize(modulePath()) === normalize(entry)
}

/**
 * runner 主体。
 *
 * 顺序是契约的一部分：**先**解析并校验 argv（纯逻辑，不加载 koffi），**再**解析原生绑定；
 * 因此参数错误在任何宿主上都能得到稳定的 127 + 前缀信息，而不是「koffi 加载失败」。
 * @param rawArgs - `process.argv.slice(2)` 形状的参数。
 * @returns 目标命令的退出码（32 位全宽）。
 */
export async function main(rawArgs: readonly string[]): Promise<number> {
  const invocation = parseRunnerArgs(rawArgs)
  validateRunnerInvocation(invocation)
  // Electron's Node mode belongs to this runner, not the restricted command.
  if (process.versions.electron) delete process.env.ELECTRON_RUN_AS_NODE
  // 子进程继承的是 runner 的环境块（lpEnvironment = NULL），所以 TMP/TEMP 必须在**这里**改。
  applyPrivateTempEnvironment(invocation.mode, invocation.temp)

  const api = await loadRunnerBindings()
  // 忽略 runner 自己的 CTRL+C：受控子进程（同一个控制台）自己处理，runner 必须活到镜像
  // 子进程退出码为止。
  if (api.setConsoleCtrlHandler(null, 1) === 0) throwLastError(api, 'SetConsoleCtrlHandler')

  const token = createRestrictedSandboxToken(api, {
    mode: invocation.mode,
    writeSid: invocation.writeSid,
    tempWriteSid: invocation.tempWriteSid,
  })
  try {
    const child = spawnRestrictedInherited(api, token, {
      command: invocation.command,
      args: invocation.args,
      cwd: process.cwd(),
    })
    return waitForRestrictedExit(api, child)
  } finally {
    api.closeHandle(token)
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      // 退出码镜像在 Windows 上是全宽的：GetExitCodeProcess 读回的 uint32（例如
      // 0xC0000005 = 3221225477）赋给 process.exitCode 之后，父进程通过 spawnSync 观察到的
      // 就是同一个数值，链路上没有任何截断或掩码。
      process.exitCode = exitCode
    },
    (error: unknown) => {
      process.stderr.write(`${RUNNER_FAILURE_PREFIX}${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = RUNNER_FAILURE_EXIT_CODE
    },
  )
}

/**
 * `@tnega/sandbox-windows-mxc`：tnega 沙箱能力缝的第二个 Windows 机制库，由 Microsoft
 * eXecution Container（MXC）的 ProcessContainer 后端强制文件策略。
 *
 * 与 `@tnega/sandbox-windows-acl` 一样，它是**机制库而不是缝的角色**：Provider
 * （`@tnega/sandbox-local`）把它放在 Windows 机制链的第一位，功能性探测通过就用它，否则
 * 退回 windows-acl。它不依赖 `@tnega/sandbox`，也不依赖 koffi —— 原生部分全在 MXC 的
 * 执行器 `wxc-exec.exe` 里，本包只负责找到执行器、拼 runner argv，runner 负责把一次调用
 * 翻译成 MXC 请求。
 *
 * 取舍与已知边界见本包 `README.md`。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export {
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
} from './runner.js'
export type { MxcNetwork, MxcRequestOptions, MxcRunnerInvocation, MxcSandboxMode } from './runner.js'

/**
 * 本后端的拒绝方言（小写子串，大小写不敏感匹配）。被拒绝的写由 Windows 自己报告，所以与
 * windows-acl 基本相同：cmd 的 "Access is denied." / 「拒绝访问」、pwsh/.NET 的
 * "Access to the path '…' is denied."、Node 的 EPERM / "operation not permitted"。
 */
export const DENIAL_SIGNATURES: readonly string[] = [
  'access is denied',
  '拒绝访问',
  'access to the path',
  'permission denied',
  'operation not permitted',
]

/** 运维显式指定执行器的环境变量。 */
export const EXEC_ENV = 'TNEGA_MXC_EXEC'

/** 提供 MXC 原生载荷的 SDK 包。 */
export const SDK_PACKAGE = '@microsoft/mxc-sdk'

/** MXC 的 Windows 一次性执行器。 */
export const EXEC_NAME = 'wxc-exec.exe'

/** {@link locateMxcExecutor} 的选项；除 `configuredPath` 外都只为测试注入。 */
export interface LocateMxcExecutorOptions {
  /** Provider 配置里显式给的路径：给了就必须存在。 */
  configuredPath?: string
  env?: NodeJS.ProcessEnv
  arch?: string
  exists?: (path: string) => boolean
  /** 解析 SDK 的 `package.json`；找不到时抛出或返回 undefined。 */
  resolveSdkManifest?: () => string | undefined
}

/** SDK 同时带 x64 与 arm64 载荷；arm64 主机上的 x64 Node 也能跑 x64 执行器。 */
function architectures(arch: string): string[] {
  return arch === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64']
}

function defaultSdkManifest(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(`${SDK_PACKAGE}/package.json`)
  } catch {
    return undefined
  }
}

/** npm 的全局前缀变量；`npm_config_*` 是 npm 生命周期脚本里的写法。 */
const PREFIX_ENV = ['NPM_CONFIG_PREFIX', 'npm_config_prefix'] as const

/** `<root>/bin/<arch>/wxc-exec.exe`，按架构顺序取第一个存在的。 */
function sdkExecutable(
  root: string,
  archs: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  for (const arch of archs) {
    const candidate = join(root, 'bin', arch, EXEC_NAME)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * 全局安装的 SDK 目录（`node_modules/@microsoft/mxc-sdk`）候选，按可信度排列：
 *
 * 1. `NPM_CONFIG_PREFIX` —— npm 自己的前缀（`~/.npmrc` 里的 `prefix=` 会改掉它）；
 * 2. `%APPDATA%\npm` —— Windows 上的默认前缀；
 * 3. `PATH` 上每个目录及其父目录 —— 全局 bin 落在 `<prefix>`（Windows）或 `<prefix>/bin`
 *    （POSIX），兄弟 `node_modules` 就在旁边，不值得为此起一次 `npm config get prefix`。
 *
 * 只认默认前缀会让装在别处的 SDK 永远找不到：prefix 是可配置的（本机就指向 `D:\` 下的
 * 目录），而 `npm install -g` 把包放进的是那个前缀，不是 `%APPDATA%\npm`。
 */
function globalSdkRoots(env: NodeJS.ProcessEnv, pathDirs: readonly string[]): string[] {
  const segment = ['node_modules', ...SDK_PACKAGE.split('/')]
  const roots: string[] = []
  for (const key of PREFIX_ENV) {
    const prefix = env[key]
    if (prefix !== undefined && prefix !== '') roots.push(join(prefix, ...segment))
  }
  const appData = env.APPDATA
  if (appData !== undefined && appData !== '') roots.push(join(appData, 'npm', ...segment))
  for (const dir of pathDirs) {
    roots.push(join(dir, ...segment), join(dirname(dir), ...segment))
  }
  return roots
}

/**
 * 找到 MXC 执行器。顺序：显式配置 → `TNEGA_MXC_EXEC` → 可解析到的 `@microsoft/mxc-sdk`
 * 载荷 → 全局安装的 SDK（`NPM_CONFIG_PREFIX`、`%APPDATA%\npm`、`PATH` 上的各前缀）→
 * `PATH` 上的 `wxc-exec.exe`。
 *
 * 执行器是原生二进制，它的位置是运维事实而不是猜测：显式给出的路径不存在就报错；
 * 什么都找不到也报错 —— Provider 据此判这个机制不可用并退回 windows-acl，绝不以非受限方式
 * 执行。
 * @returns 执行器的绝对路径。
 * @throws Error 列出所有提供执行器的方式。
 */
export function locateMxcExecutor(options: LocateMxcExecutorOptions = {}): string {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  if (options.configuredPath !== undefined) {
    if (!exists(options.configuredPath)) throw new Error(`configured MXC executor does not exist: ${options.configuredPath}`)
    return options.configuredPath
  }
  const fromEnv = env[EXEC_ENV]
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!exists(fromEnv)) throw new Error(`${EXEC_ENV} does not exist: ${fromEnv}`)
    return fromEnv
  }
  const manifest = (options.resolveSdkManifest ?? defaultSdkManifest)()
  const archs = architectures(options.arch ?? process.arch)
  const pathDirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const sdkRoots = manifest === undefined
    ? globalSdkRoots(env, pathDirs)
    : [dirname(manifest), ...globalSdkRoots(env, pathDirs)]
  for (const root of sdkRoots) {
    const found = sdkExecutable(root, archs, exists)
    if (found !== undefined) return found
  }
  for (const dir of pathDirs) {
    const candidate = join(dir, EXEC_NAME)
    if (exists(candidate)) return candidate
  }
  throw new Error(
    `MXC executor ${EXEC_NAME} not found: set ${EXEC_ENV}, install ${SDK_PACKAGE}, or put ${EXEC_NAME} on PATH`,
  )
}

/** MXC ProcessContainer 的系统下限：Windows 11 24H2（build 26100）。 */
export const MXC_MIN_WINDOWS_BUILD = 26100

/** 安装 MXC 执行器的一条命令（全局 SDK 会被 {@link locateMxcExecutor} 找到）。 */
export const MXC_INSTALL_COMMAND = `npm install -g ${SDK_PACKAGE}`

/** SDK 的说明页。 */
export const MXC_INSTALL_URL = `https://www.npmjs.com/package/${SDK_PACKAGE}`

/**
 * 本机的 MXC 安装状态，供界面提示用，不起任何进程：
 *
 * - `unsupported`：不是 Windows，或系统低于 MXC 的下限 —— 装了也用不上，不提示；
 * - `disabled`：`TNEGA_MXC_EXEC=off`，运维选择不用；
 * - `missing`：系统够新但找不到执行器 —— 值得提示安装；
 * - `installed`：找到了执行器（是否真能用由 Provider 的功能性探测决定）。
 */
export type MxcSetup = 'unsupported' | 'disabled' | 'missing' | 'installed'

export interface MxcSetupOptions extends LocateMxcExecutorOptions {
  platform?: NodeJS.Platform
  /** `os.release()`，Windows 上形如 `10.0.26100`。 */
  release?: string
}

export function mxcSetup(options: MxcSetupOptions = {}): MxcSetup {
  if ((options.platform ?? process.platform) !== 'win32') return 'unsupported'
  const build = Number((options.release ?? release()).split('.')[2])
  if (!Number.isInteger(build) || build < MXC_MIN_WINDOWS_BUILD) return 'unsupported'
  if ((options.env ?? process.env)[EXEC_ENV]?.toLowerCase() === 'off') return 'disabled'
  try {
    locateMxcExecutor(options)
    return 'installed'
  } catch {
    return 'missing'
  }
}

/** 发布形态的 runner 文件名（与本模块打成的包入口同目录）。 */
const PUBLISHED_RUNNER_FILE = './sandbox-windows-mxc-runner.js'
/** 仓库内 dev / vitest 形态：Node 22 的类型剥离直接执行它。 */
const DEV_RUNNER_FILE = './runner.ts'

export interface ResolveMxcRunnerCommandOptions {
  /** 显式 runner argv 前缀（给了就用，不做探测）。 */
  runnerCommand?: readonly string[]
  /** 解析锚点，默认本模块；只用于测试。 */
  moduleUrl?: string | URL
}

/**
 * runner 命令前缀：`[process.execPath, <runner 绝对路径>]`。与 windows-acl 同一规则：
 * 先找发布形态的同目录产物，再找仓库内的 `runner.ts`，都没有就抛出。
 */
export function resolveMxcRunnerCommand(options: ResolveMxcRunnerCommandOptions = {}): readonly string[] {
  if (options.runnerCommand !== undefined) {
    if (options.runnerCommand.length === 0) throw new Error('windows-mxc runnerCommand override must not be empty')
    return [...options.runnerCommand]
  }
  const anchor = options.moduleUrl ?? import.meta.url
  const candidates = [PUBLISHED_RUNNER_FILE, DEV_RUNNER_FILE].map(file => fileURLToPath(new URL(file, anchor)))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [process.execPath, candidate]
  }
  throw new Error(`windows-mxc runner entry not found next to this module; tried ${candidates.join(' and ')}`)
}

export const name = '@tnega/sandbox-windows-mxc'

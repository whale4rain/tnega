/**
 * runner argv 前缀解析：Provider（`@tnega/sandbox-local`）拿到
 * `[process.execPath, <runner 绝对路径>]` 之后再拼 `--workspace/--temp/--mode/[SID]/-- argv`。
 *
 * 解析规则——它是**本包**的能力，因此只看本模块自己所在的位置，不引用任何调用方的目录：
 *
 * 1. 配置给了 `runnerCommand` → 原样返回（运维的断言，不做探测）；
 * 2. 与本模块**同目录**存在 `sandbox-windows-acl-runner.js`（发布形态：根包把本包打成
 *    `dist/sandbox-windows-acl.js`、runner 单独出 `dist/sandbox-windows-acl-runner.js`，
 *    两者同目录）；
 * 3. 否则与本模块同目录存在 `runner.ts`（仓库内 dev / vitest 形态，Node 22 的类型剥离直接
 *    执行它，不需要 tsx 之类的加载器）；
 * 4. 都不存在 → 抛出并列出尝试过的路径。
 *
 * 绝不静默回退到「非受限执行」：拿不到 runner 就是拿不到受限执行。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 发布形态的 runner 文件名（与本模块同目录）。 */
const PUBLISHED_RUNNER_FILE = './sandbox-windows-acl-runner.js'
/** 仓库内 dev 形态的 runner 文件名（与本模块同目录）。 */
const DEV_RUNNER_FILE = './runner.ts'

/** {@link resolveRunnerCommand} 的选项。 */
export interface ResolveRunnerCommandOptions {
  /**
   * 显式指定的 runner argv 前缀（给了就用，不做探测）。
   *
   * 运维显式指定 runner 就是断言「它就是那个 runner」；此处的唯一检查是非空。
   */
  runnerCommand?: readonly string[]
  /**
   * 解析锚点，默认本模块的 `import.meta.url`。
   *
   * 只用于测试：给一个指向「同目录里有 `sandbox-windows-acl-runner.js`」的假模块 URL，就能在
   * 仓库内覆盖发布形态那一步，而不必真的去构建发布产物。
   */
  moduleUrl?: string | URL
}

/**
 * 解析 runner 命令行前缀。
 * @param options - 可选的显式覆盖与测试用解析锚点。
 * @returns `[process.execPath, <runner 绝对路径>]`。
 */
export function resolveRunnerCommand(options: ResolveRunnerCommandOptions = {}): readonly string[] {
  const override = options.runnerCommand
  if (override !== undefined) {
    if (override.length === 0) {
      throw new Error('windows-acl runnerCommand override must not be empty; omit it to resolve the package runner')
    }
    return [...override]
  }
  const anchor = options.moduleUrl ?? import.meta.url
  const candidates = [PUBLISHED_RUNNER_FILE, DEV_RUNNER_FILE]
    .map(candidate => fileURLToPath(new URL(candidate, anchor)))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [process.execPath, candidate]
  }
  throw new Error(
    `windows-acl runner entry not found next to this module; tried ${candidates.join(' and ')}. `
    + 'Pass an explicit runnerCommand, or run from a checkout/build that ships the runner next to the package entry.',
  )
}

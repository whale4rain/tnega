/**
 * 路径围栏的唯一实现在 `@tnega/fs-sandbox`。这个文件只做转发，保留既有导入路径：
 * 文件工具、搜索 Consumer与被测试钉死的错误文案都不需要改。
 *
 * 之所以不让 `@tnega/tools` 自己留一份：`resolveInside` 是「什么算工作区之内」的
 * 唯一定义，两份实现会漂移，最终表现为 `write_file` 与 shell 对同一个路径给出不同
 * 结论。
 */
import { resolve } from 'node:path'
import { resolveInside } from '@tnega/fs-sandbox'

export { PathSandboxError, resolveInside } from '@tnega/fs-sandbox'
export type { PathSandboxErrorCode } from '@tnega/fs-sandbox'


/** A switch a tool reads per call: fixed, or decided when the call runs (a permission can change mid-session). */
export type ToolSwitch = boolean | (() => boolean | Promise<boolean>)

export async function switchOn(value: ToolSwitch): Promise<boolean> {
  return typeof value === 'function' ? await value() : value
}

/**
 * The one place a tool turns a model-given path into an absolute one: fenced
 * inside `cwd` unless `allowOutside` (the `bypass` permission) is on. `shell`
 * and the file tools share it so they never judge one path differently.
 */
export async function resolveWorkspacePath(cwd: string, allowOutside: ToolSwitch, path: string): Promise<string> {
  return await switchOn(allowOutside) ? resolve(cwd, path) : await resolveInside(cwd, path)
}

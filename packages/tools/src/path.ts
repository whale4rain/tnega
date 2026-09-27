/**
 * 路径围栏的唯一实现在 `@tnega/fs-sandbox`。这个文件只做转发，保留既有导入路径：
 * 文件工具、搜索 Consumer、eval fixture 与被测试钉死的错误文案都不需要改。
 *
 * 之所以不让 `@tnega/tools` 自己留一份：`resolveInside` 是「什么算工作区之内」的
 * 唯一定义，两份实现会漂移，最终表现为 `write_file` 与 shell 对同一个路径给出不同
 * 结论。
 */
export { PathSandboxError, resolveInside } from '@tnega/fs-sandbox'
export type { PathSandboxErrorCode } from '@tnega/fs-sandbox'

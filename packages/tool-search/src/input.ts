import { ToolInputError } from '@tnega/tools'

/** 工具入参强制转换：直调 `tool.execute` 时（测试或内嵌使用）越过注册表校验的兜底。 */

export function record(value: unknown, label = 'input'): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new ToolInputError(`${label} must be an object`)
}

export function stringField(value: unknown, name: string): string {
  if (typeof value === 'string') return value
  throw new ToolInputError(`${name} must be a string`)
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return stringField(value, name)
}

export function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new ToolInputError(`${name} must be a finite number`)
}

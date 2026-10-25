import { ToolInputError } from './errors.js'

/**
 * Argument readers for the builtin tools.
 *
 * Every one reports a field by name and refuses a value of the wrong type, so
 * a model that passes `"limit": "10"` reads a message about `limit` instead of
 * a stack trace. They live here rather than in one tool file so the file tools
 * and the utility tools validate the same way.
 */
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

export function numberField(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new ToolInputError(`${name} must be a finite number`)
}

export function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  return numberField(value, name)
}

export function booleanField(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') return value
  throw new ToolInputError(`${name} must be a boolean`)
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  return booleanField(value, name)
}

export function optionalRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const source = record(value, name)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== 'string') throw new ToolInputError(`${name}.${key} must be a string`)
    result[key] = entry
  }
  return result
}

export function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

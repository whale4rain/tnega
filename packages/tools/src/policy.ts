import { ToolInputError } from './builtins.js'
import { describeParameters, describeUnparsedArguments } from './errors.js'
import type {
  ToolDefinition,
  ToolParameterSchema,
  ToolRequest,
  ToolResult,
} from './index.js'

export type ToolInputValidator = (
  input: unknown,
  tool: ToolDefinition,
) => void | Promise<void>

export type ToolAuthorizer = (
  request: ToolRequest,
) => boolean | Promise<boolean>

export type ToolResultTruncator = (
  result: ToolResult,
  request: ToolRequest,
) => ToolResult | Promise<ToolResult>

export interface ToolPolicy {
  validator?: ToolInputValidator
  authorizer?: ToolAuthorizer
  truncator?: ToolResultTruncator
}

export class ToolAuthorizationError extends Error {
  override name = 'ToolAuthorizationError'
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    default:
      return true
  }
}

export function validateSchema(
  input: unknown,
  schema: ToolParameterSchema | undefined,
): string[] {
  if (!schema) return []

  const issues: string[] = []
  if (schema.type && !matchesType(input, schema.type)) {
    issues.push(`expected ${schema.type}, received ${typeName(input)}`)
    return issues
  }

  const objectLike = schema.type === 'object'
    || Boolean(schema.properties)
    || (schema.required?.length ?? 0) > 0
  if (objectLike && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    issues.push('expected object')
    return issues
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(value => JSON.stringify(value) === JSON.stringify(input))) {
    issues.push(`must be one of ${schema.enum.join(', ')}`)
  }
  if (typeof input === 'number') {
    if (typeof schema.minimum === 'number' && input < schema.minimum) issues.push(`must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && input > schema.maximum) issues.push(`must be <= ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && input <= schema.exclusiveMinimum) issues.push(`must be > ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && input >= schema.exclusiveMaximum) issues.push(`must be < ${schema.exclusiveMaximum}`)
  }
  if (typeof input === 'string') {
    const length = Array.from(input).length
    if (typeof schema.minLength === 'number' && length < schema.minLength) issues.push(`length must be >= ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) issues.push(`length must be <= ${schema.maxLength}`)
  }
  if (Array.isArray(input)) {
    if (typeof schema.minItems === 'number' && input.length < schema.minItems) issues.push(`item count must be >= ${schema.minItems}`)
    if (typeof schema.maxItems === 'number' && input.length > schema.maxItems) issues.push(`item count must be <= ${schema.maxItems}`)
    const items = schema.items
    if (isSchema(items)) {
      input.forEach((value, index) => {
        issues.push(...validateSchema(value, items).map(issue => `[${index}].${issue}`))
      })
    }
    return issues
  }
  if (!objectLike || !isSchema(input)) return issues
  const record = input
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(record, key)) issues.push(`missing required property: ${key}`)
  }

  for (const [key, raw] of Object.entries(schema.properties ?? {})) {
    const value = record[key]
    if (value === undefined) continue
    if (!isSchema(raw)) continue
    const nested = validateSchema(value, raw)
    if (nested.length) issues.push(...nested.map(issue => issue.startsWith('must be one of') ? `${key} ${issue}` : `${key}.${issue}`))
  }

  for (const key of Object.keys(record)) {
    if (Object.hasOwn(schema.properties ?? {}, key)) continue
    if (schema.additionalProperties === false) issues.push(`unexpected property: ${key}`)
    else if (isSchema(schema.additionalProperties)) {
      issues.push(...validateSchema(record[key], schema.additionalProperties).map(issue => `${key}.${issue}`))
    }
  }

  return issues
}

function isSchema(value: unknown): value is ToolParameterSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject input that does not fit the tool's schema. The message names the
 * tool, each problem, and the expected call shape, so a model can correct the
 * call in one step instead of guessing.
 */
export function validateToolInput(input: unknown, tool: ToolDefinition): void {
  const issues = validateSchema(input, tool.schema.parameters)
  if (!issues.length) return
  const name = tool.schema.name
  const unparsed = typeof input === 'string' ? describeUnparsedArguments(input) : undefined
  const problem = unparsed ?? issues.join('; ')
  throw new ToolInputError(`invalid arguments for ${name}: ${problem}. Expected ${describeParameters(name, tool.schema.parameters)}`)
}

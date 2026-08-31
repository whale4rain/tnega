import { ToolInputError } from './builtins.js'
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
  if (!objectLike || typeof input !== 'object' || input === null || Array.isArray(input)) {
    return issues
  }

  const record = input as Record<string, unknown>
  for (const key of schema.required ?? []) {
    if (!(key in record)) issues.push(`missing required property: ${key}`)
  }

  for (const [key, raw] of Object.entries(schema.properties ?? {})) {
    const value = record[key]
    if (value === undefined) continue
    if (!raw || typeof raw !== 'object') continue
    const property = raw as ToolParameterSchema
    const nested = validateSchema(value, property)
    if (nested.length) issues.push(...nested.map(issue => `${key}.${issue}`))
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      issues.push(`${key} must be one of ${property.enum.join(', ')}`)
    }
  }

  if (schema.type === 'array' && Array.isArray(input) && schema.items) {
    const itemSchema = schema.items as ToolParameterSchema
    for (let index = 0; index < input.length; index += 1) {
      const nested = validateSchema(input[index], itemSchema)
      if (nested.length) issues.push(...nested.map(issue => `[${index}].${issue}`))
    }
  }

  return issues
}

export function validateToolInput(input: unknown, tool: ToolDefinition): void {
  const issues = validateSchema(input, tool.schema.parameters)
  if (issues.length) throw new ToolInputError(issues.join('; '))
}

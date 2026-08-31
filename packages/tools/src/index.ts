import type { Context, Disposable } from '@tnega/core'
import { Service } from '@tnega/core'
import { ToolAuthorizationError, validateToolInput } from './policy.js'
import type {
  ToolAuthorizer,
  ToolInputValidator,
  ToolPolicy,
  ToolResultTruncator,
} from './policy.js'

export * from './builtins.js'
export * from './calc.js'
export * from './path.js'
export {
  ToolAuthorizationError,
  validateSchema,
  validateToolInput,
  type ToolAuthorizer,
  type ToolInputValidator,
  type ToolPolicy,
  type ToolResultTruncator,
} from './policy.js'

export interface ToolParameterSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface ToolSchema {
  name: string
  description: string
  parameters?: ToolParameterSchema
}

export interface ToolExecuteOptions {
  callId?: string
  signal?: AbortSignal
  [key: string]: unknown
}

export type ToolExecutor = (
  input: unknown,
  options: ToolExecuteOptions,
) => unknown | Promise<unknown>

export interface ToolDefinition {
  schema: ToolSchema
  execute: ToolExecutor
  metadata?: Record<string, unknown>
  policy?: ToolPolicy
}

export interface ToolError {
  name: string
  message: string
  stack?: string
}

export interface ToolResult {
  ok: boolean
  name: string
  callId?: string
  input: unknown
  output?: unknown
  error?: ToolError
  startedAt: number
  durationMs: number
}

export interface ToolRequest {
  tool: ToolDefinition
  name: string
  input: unknown
  options: ToolExecuteOptions
  startedAt: number
}

export interface ToolStagePayload {
  request: ToolRequest
  result: ToolResult
}

export interface ToolsConfig extends ToolPolicy {
  [key: string]: unknown
}

export class ToolNotFoundError extends Error {
  override name = 'ToolNotFoundError'

  constructor(readonly toolName: string) {
    super(`tool not found: ${toolName}`)
  }
}

export class ToolAlreadyRegisteredError extends Error {
  override name = 'ToolAlreadyRegisteredError'

  constructor(readonly toolName: string) {
    super(`tool already registered: ${toolName}`)
  }
}

function toToolError(error: unknown): ToolError {
  if (error instanceof Error) {
    const result: ToolError = {
      name: error.name,
      message: error.message,
    }
    if (error.stack) result.stack = error.stack
    return result
  }
  return {
    name: 'ToolExecutionError',
    message: String(error),
  }
}

export class ToolsService extends Service<never> {
  static provide = 'tools'

  private _tools = new Map<string, ToolDefinition>()
  private _policy: {
    validator: ToolInputValidator
    authorizer?: ToolAuthorizer
    truncator?: ToolResultTruncator
  }

  constructor(ctx: Context, config: ToolsConfig = {}) {
    super(ctx, 'tools')
    this._policy = {
      validator: config.validator ?? validateToolInput,
    }
    if (config.authorizer !== undefined) this._policy.authorizer = config.authorizer
    if (config.truncator !== undefined) this._policy.truncator = config.truncator
  }

  register(definition: ToolDefinition): Disposable {
    this._validate(definition)
    const name = definition.schema.name
    return this.ctx.fiber.effect(() => {
      if (this._tools.has(name)) {
        throw new ToolAlreadyRegisteredError(name)
      }
      this._tools.set(name, definition)
      return () => {
        this._tools.delete(name)
      }
    }, `ctx.tools.register(${JSON.stringify(name)})`)
  }

  unregister(name: string): boolean {
    return this._tools.delete(name)
  }

  has(name: string): boolean {
    return this._tools.has(name)
  }

  list(): readonly ToolDefinition[] {
    return [...this._tools.values()]
  }

  toSpecs(): readonly ToolSchema[] {
    return this.list().map(tool => tool.schema)
  }

  async execute(
    name: string,
    input: unknown,
    options: ToolExecuteOptions = {},
  ): Promise<ToolResult> {
    const tool = this._tools.get(name)
    if (!tool) throw new ToolNotFoundError(name)

    const request: ToolRequest = {
      tool,
      name,
      input,
      options,
      startedAt: Date.now(),
    }

    await this.ctx.parallel('tools/pre-execute', request)

    const policy = request.tool.policy
    const authorizer = policy?.authorizer ?? this._policy.authorizer
    if (authorizer) {
      const allowed = await authorizer(request)
      if (!allowed) {
        return this._finish(
          request,
          this._failure(
            request,
            new ToolAuthorizationError(`tool authorization denied: ${name}`),
          ),
        )
      }
    }

    const validator = policy?.validator ?? this._policy.validator
    try {
      await validator(request.input, request.tool)
    } catch (error) {
      return this._finish(request, this._failure(request, error))
    }

    let output: unknown
    let caught: unknown
    try {
      await this.ctx.parallel('tools/execute', request)
      output = await tool.execute(request.input, request.options)
    } catch (error) {
      caught = error
    }

    const result = caught === undefined
      ? this._success(request, output)
      : this._failure(request, caught)

    const truncator = policy?.truncator ?? this._policy.truncator
    if (truncator) {
      try {
        return this._finish(request, await truncator(result, request))
      } catch (error) {
        return this._finish(request, this._failure(request, error))
      }
    }

    return this._finish(request, result)
  }

  private async _finish(
    request: ToolRequest,
    result: ToolResult,
  ): Promise<ToolResult> {
    await this.ctx.parallel('tools/post-execute', { request, result })
    await this.ctx.parallel('tools/result', { request, result })
    return result
  }

  private _validate(definition: ToolDefinition): void {
    if (!definition || typeof definition.schema?.name !== 'string' || !definition.schema.name) {
      throw new TypeError('tool definition requires a non-empty schema.name')
    }
    if (typeof definition.execute !== 'function') {
      throw new TypeError(`tool "${definition.schema.name}" requires an execute function`)
    }
  }

  private _success(request: ToolRequest, output: unknown): ToolResult {
    const result: ToolResult = {
      ok: true,
      name: request.name,
      input: request.input,
      output,
      startedAt: request.startedAt,
      durationMs: Date.now() - request.startedAt,
    }
    if (request.options.callId) result.callId = request.options.callId
    return result
  }

  private _failure(request: ToolRequest, error: unknown): ToolResult {
    const result: ToolResult = {
      ok: false,
      name: request.name,
      input: request.input,
      error: toToolError(error),
      startedAt: request.startedAt,
      durationMs: Date.now() - request.startedAt,
    }
    if (request.options.callId) result.callId = request.options.callId
    return result
  }
}

export const tools = {
  name: 'tools',
  apply(ctx: Context, config: ToolsConfig = {}) {
    new ToolsService(ctx, config)
  },
}

export const name = '@tnega/tools'

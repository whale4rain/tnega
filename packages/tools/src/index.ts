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
export * from './execution.js'
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
  /** Runtime opt-in: mark a successful result as concluding the agent turn. */
  concludesTurn?: boolean
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
  /** When true, the agent turn should stop after this tool result. */
  concludesTurn?: boolean
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

/**
 * Final pre-dispatch check evaluated after the `tools/pre-execute` waterfall.
 * A returned reason denies the call; `undefined` leaves it unchanged. Guards
 * are monotonic: no later listener can re-allow a denied call.
 */
export type ToolGuard = (
  request: ToolRequest,
) => string | undefined | Promise<string | undefined>

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
  private _guards = new Set<ToolGuard>()
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

  /** Register a monotonic guard evaluated after pre-execute policy. */
  guard(guard: ToolGuard): Disposable {
    if (typeof guard !== 'function') throw new TypeError('tool guard must be a function')
    return this.ctx.fiber.effect(() => {
      this._guards.add(guard)
      return () => {
        this._guards.delete(guard)
      }
    }, 'ctx.tools.guard()')
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

    let request: ToolRequest = {
      tool,
      name,
      input,
      options,
      startedAt: Date.now(),
    }

    let preError: unknown
    try {
      const resolved = await this.ctx.waterfallAsync(
        'tools/pre-execute',
        request,
        async (payload: ToolRequest) => {
          await this._applyPolicy(payload)
          return payload
        },
      )
      if (!resolved) {
        throw new ToolAuthorizationError(`tool rejected by tools/pre-execute: ${name}`)
      }
      request = resolved
      const denial = await this._checkGuards(request)
      if (denial) throw new ToolAuthorizationError(denial)
    } catch (error) {
      preError = error
    }

    let result: ToolResult | undefined
    try {
      if (!preError) {
        result = await this.ctx.waterfallAsync(
          'tools/execute',
          request,
          async (payload: ToolRequest) => {
            const output = await payload.tool.execute(payload.input, payload.options)
            return this._success(payload, output)
          },
        )
      }
    } catch (error) {
      result = this._failure(request, error)
    }
    if (preError) result = this._failure(request, preError)
    if (!result) {
      result = this._failure(
        request,
        new Error('tools/execute did not return a tool result'),
      )
    }

    try {
      const normalized = await this.ctx.waterfallAsync(
        'tools/post-execute',
        { request, result },
        async (payload: ToolStagePayload) => {
          const policy = payload.request.tool.policy
          const truncator = policy?.truncator ?? this._policy.truncator
          return truncator
            ? await truncator(payload.result, payload.request)
            : payload.result
        },
      )
      if (normalized && typeof normalized.ok === 'boolean') result = normalized
    } catch (error) {
      result = this._failure(request, error)
    }

    return this._finish(
      request,
      result ?? this._failure(
        request,
        new Error('tools/execute did not return a tool result'),
      ),
    )
  }

  private async _finish(
    request: ToolRequest,
    result: ToolResult,
  ): Promise<ToolResult> {
    await this.ctx.parallel('tools/result', { request, result })
    return result
  }

  private async _applyPolicy(request: ToolRequest): Promise<void> {
    const policy = request.tool.policy
    const authorizer = policy?.authorizer ?? this._policy.authorizer
    if (authorizer) {
      const allowed = await authorizer(request)
      if (!allowed) {
        throw new ToolAuthorizationError(`tool authorization denied: ${request.name}`)
      }
    }
    const validator = policy?.validator ?? this._policy.validator
    if (validator) await validator(request.input, request.tool)
  }

  private async _checkGuards(request: ToolRequest): Promise<string | undefined> {
    for (const guard of this._guards) {
      const denial = await guard(request)
      if (denial) return denial
    }
    return undefined
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
    this._applyConcludesTurn(request, result)
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
    this._applyConcludesTurn(request, result)
    return result
  }

  private _applyConcludesTurn(request: ToolRequest, result: ToolResult): void {
    const staticDeclares = (request.tool.metadata as { concludesTurn?: unknown } | undefined)
      ?.concludesTurn
    if (staticDeclares === true || request.options.concludesTurn === true) {
      result.concludesTurn = true
    }
  }
}

export const tools = {
  name: 'tools',
  apply(ctx: Context, config: ToolsConfig = {}) {
    new ToolsService(ctx, config)
  },
}

export const name = '@tnega/tools'

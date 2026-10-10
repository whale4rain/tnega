import type { Context, Disposable } from '@tnega/core'
import { Service } from '@tnega/core'
import { closestToolNames, ToolAbortError, toToolError } from './errors.js'
import { ToolAuthorizationError, validateToolInput } from './policy.js'
import type {
  ToolAuthorizer,
  ToolInputValidator,
  ToolPolicy,
  ToolResultTruncator,
} from './policy.js'

export * from './builtins.js'
export * from './processes.js'
export * from './calc.js'
export * from './path.js'
export { closestToolNames, describeError, describeParameters, ToolAbortError, toToolError } from './errors.js'
export * from '@tnega/execution'
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
  /** Stable identity of the Agent executing this tool call, when available. */
  agentId?: string
  /** Runtime opt-in: mark a successful result as concluding the agent turn. */
  concludesTurn?: boolean
  /**
   * Output the call has produced so far, one piece at a time. The host keeps
   * its tail durably, so a call a crash cuts off can still say what it printed.
   */
  progress?: (output: string) => void
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
  /**
   * Cooperative wall-clock budget for one call. The registry arms a deadline
   * and hands the tool a composed `signal`; the tool is expected to observe the
   * abort and reach quiescence. A tool that declares none runs without one.
   */
  timeoutMs?: number
  /** Restart disposition; no tool is automatically replayed after interruption. */
  interruption?: 'fail' | 'retry' | 'confirm'
}

export interface ToolError {
  name: string
  message: string
  stack?: string
}

/**
 * An image a tool hands back to the model. Structurally identical to the
 * Session's `ImageAttachment`; tools does not depend on session.
 */
export interface ToolAttachment {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** Base64 without a `data:` prefix. */
  data: string
  name?: string
}

const TOOL_OUTPUT_WITH_ATTACHMENTS = Symbol.for('tnega.tools.outputWithAttachments')

interface ToolOutputWithAttachments {
  readonly [TOOL_OUTPUT_WITH_ATTACHMENTS]: true
  output: unknown
  attachments: ToolAttachment[]
}

/**
 * Return value for a tool that produces images: `output` stays the text the
 * model reads through `renderToolResult`, `attachments` travel beside it.
 */
export function withAttachments(output: unknown, attachments: readonly ToolAttachment[]): unknown {
  const wrapped: ToolOutputWithAttachments = {
    [TOOL_OUTPUT_WITH_ATTACHMENTS]: true,
    output,
    attachments: [...attachments],
  }
  return wrapped
}

function unwrapAttachments(value: unknown): { output: unknown; attachments?: ToolAttachment[] } {
  if (value && typeof value === 'object' && TOOL_OUTPUT_WITH_ATTACHMENTS in value) {
    const wrapped = value as ToolOutputWithAttachments
    return wrapped.attachments.length
      ? { output: wrapped.output, attachments: wrapped.attachments }
      : { output: wrapped.output }
  }
  return { output: value }
}

export interface ToolResult {
  ok: boolean
  name: string
  callId?: string
  input: unknown
  output?: unknown
  /** Images produced by the tool (see {@link withAttachments}). */
  attachments?: ToolAttachment[]
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
  /**
   * How long a call may keep running after its signal aborts before the
   * registry settles it as aborted without the tool. Defaults to
   * {@link TOOL_ABORT_GRACE_MS}.
   */
  abortGraceMs?: number
  [key: string]: unknown
}

/**
 * Time a cancelled call gets to report its own cancellation. A tool that
 * ignores its signal (an MCP server that never answers, a plugin awaiting
 * something unrelated) is settled after it, so a stop never waits on the tool.
 */
export const TOOL_ABORT_GRACE_MS = 2_000

/**
 * Settle with `work`, or with a {@link ToolAbortError} once `signal` has been
 * aborted for `graceMs` and `work` still has not settled. The abandoned work
 * keeps running; its eventual outcome is dropped.
 */
function settleOnAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, graceMs: number): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        reject(new ToolAbortError(`tool call did not stop within ${graceMs}ms of cancellation and was abandoned`))
      }, graceMs)
    }
    const release = (): void => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => { release(); resolve(value) },
      (error: unknown) => { release(); reject(error) },
    )
  })
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

  /** `available` lets the message point a model at the name it meant. */
  constructor(readonly toolName: string, available: readonly string[] = []) {
    super(`tool not found: ${toolName}${toolNotFoundHint(toolName, available)}`)
  }
}

function toolNotFoundHint(name: string, available: readonly string[]): string {
  if (!available.length) return ''
  const close = closestToolNames(name, available)
  if (close.length) return `. Did you mean ${close.join(' or ')}?`
  const listed = available.slice(0, 40).join(', ')
  return `. Available tools: ${listed}${available.length > 40 ? ', …' : ''}`
}

export class ToolAlreadyRegisteredError extends Error {
  override name = 'ToolAlreadyRegisteredError'

  constructor(readonly toolName: string) {
    super(`tool already registered: ${toolName}`)
  }
}

/**
 * Raised in place of a tool's own result when the tool's declared budget
 * expired. Only the registry's own deadline produces it, so a nested outer
 * cancellation the tool already reported stays an ordinary abort.
 */
export class ToolTimeoutError extends Error {
  override name = 'ToolTimeoutError'

  constructor(readonly toolName: string, readonly timeoutMs: number) {
    super(`tool call timed out after ${timeoutMs}ms: ${toolName}. The call was stopped; split the work into smaller calls, or run it in the background if a background tool such as job_start is available`)
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
  private readonly _abortGraceMs: number

  constructor(ctx: Context, config: ToolsConfig = {}) {
    super(ctx, 'tools')
    this._policy = {
      validator: config.validator ?? validateToolInput,
    }
    if (config.authorizer !== undefined) this._policy.authorizer = config.authorizer
    if (config.truncator !== undefined) this._policy.truncator = config.truncator
    this._abortGraceMs = config.abortGraceMs ?? TOOL_ABORT_GRACE_MS
  }

  register(definition: ToolDefinition): Disposable {
    this._validate(definition)
    const name = definition.schema.name
    return this.ctx.fiber.effect(() => {
      if (this._tools.has(name)) {
        throw new ToolAlreadyRegisteredError(name)
      }
      this._tools.set(name, definition)
      this.ctx.emit('tools/change')
      return () => {
        this._tools.delete(name)
        this.ctx.emit('tools/change')
      }
    }, `ctx.tools.register(${JSON.stringify(name)})`)
  }

  unregister(name: string): boolean {
    const removed = this._tools.delete(name)
    if (removed) this.ctx.emit('tools/change')
    return removed
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
    if (!tool) throw new ToolNotFoundError(name, [...this._tools.keys()])

    const timeoutMs = tool.timeoutMs ?? 0
    const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    let toolOptions: ToolExecuteOptions = options
    if (deadline !== undefined) {
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
      toolOptions = { ...options, signal }
    }

    let request: ToolRequest = {
      tool,
      name,
      input,
      options: toolOptions,
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
        result = await settleOnAbort(
          this.ctx.waterfallAsync(
            'tools/execute',
            request,
            async (payload: ToolRequest) => {
              const output = await payload.tool.execute(payload.input, payload.options)
              return this._success(payload, output)
            },
          ),
          request.options.signal,
          this._abortGraceMs,
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

    // Only this call's own deadline produces a timeout. When the caller's
    // signal aborted too, the tool's own abort result stands.
    if (deadline?.aborted && !options.signal?.aborted) {
      result = this._failure(request, new ToolTimeoutError(name, timeoutMs))
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

  private _success(request: ToolRequest, value: unknown): ToolResult {
    const { output, attachments } = unwrapAttachments(value)
    const result: ToolResult = {
      ok: true,
      name: request.name,
      input: request.input,
      output,
      startedAt: request.startedAt,
      durationMs: Date.now() - request.startedAt,
    }
    if (attachments) result.attachments = attachments
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

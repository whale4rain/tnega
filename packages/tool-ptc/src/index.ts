import { randomUUID } from 'node:crypto'
import type { AgentRequestEvent } from '@tnega/agent'
import type { Context } from '@tnega/core'
import type { PtcBinding } from '@tnega/ptc-runtime'
import { renderToolResult, type SessionLog } from '@tnega/session'
import type { ToolsService, ToolExecuteOptions } from '@tnega/tools'

export type PtcMode = 'native' | 'both' | 'ptc'
export interface ToolPtcConfig {
  mode?: PtcMode
  maxCodeChars?: number
  maxResultChars?: number
  resolveSession?: (agentId?: string) => SessionLog | undefined
}

export class PtcExecutionError extends Error {
  override name = 'PtcExecutionError'
}

function bounded(value: unknown, limit: number): unknown {
  const text = renderToolResult({ ok: true, output: value })
  return text.length > limit ? { truncated: true, preview: text.slice(0, limit) } : value
}

export const toolPtc = {
  name: 'tool-ptc',
  inject: ['tools', 'ptcRuntime'],
  apply(ctx: Context, config: ToolPtcConfig = {}): void {
    const mode = config.mode ?? 'both'
    if (!['native', 'both', 'ptc'].includes(mode)) throw new Error('Invalid PTC mode')
    if (mode === 'native') return
    const maxCodeChars = config.maxCodeChars ?? 32_000
    const maxResultChars = config.maxResultChars ?? 64_000
    for (const [name, limit] of Object.entries({ maxCodeChars, maxResultChars })) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`${name} must be a positive integer`)
    }
    const registry: ToolsService = ctx.get('tools')
    registry.register({
      schema: {
        name: 'run_code',
        description: 'Run JavaScript orchestration in an isolated QuickJS VM. Call tools through the tools object only, e.g. await tools.read_file({path: "README.md"}); read_file() is not a global function. Before using an unfamiliar tool, inspect text(ALL_TOOLS.filter(t => t.name === "tool_name")); each entry has name and description, with its JSON input schema embedded in description. Tool promises resolve directly to the tool output, without an added {ok, output, value} wrapper: strings stay strings, arrays stay arrays. Do not guess return fields; inspect a small result first. Errors reject the promise; use try/catch for independent operations. Registered tools keep their usual permissions. text(value) emits output; return a value. No filesystem, process, fetch, require, imports or timers. Calls are serialized, including Promise.all. Do not retry an entire script after partial side effects; inspect results and retry only the failed operation. A fresh VM is used on every call; store/load do not persist between calls.',
        parameters: {
          type: 'object', properties: { code: { type: 'string', maxLength: maxCodeChars } },
          required: ['code'], additionalProperties: false,
        },
      },
      metadata: { permissionBoundary: 'nested-tools', executionMode: 'exclusive' },
      async execute(input: unknown, options: ToolExecuteOptions) {
        if (typeof input !== 'object' || input === null || !('code' in input)
          || typeof input.code !== 'string' || !input.code.trim() || input.code.length > maxCodeChars) {
          throw new Error(`run_code requires nonempty code up to ${maxCodeChars} characters`)
        }
        const parentCallId = options.callId ?? randomUUID()
        const session = config.resolveSession?.(options.agentId)
        let queue: Promise<void> = Promise.resolve()
        const bindings: PtcBinding[] = registry.list()
          .filter(tool => tool.schema.name !== 'run_code' && tool.metadata?.ptc !== false)
          .map(tool => ({
            name: tool.schema.name,
            description: tool.schema.description + ' Input schema: ' + JSON.stringify(tool.schema.parameters ?? {}),
            parameters: tool.schema.parameters ?? {},
            execute(input, signal) {
              const execute = async (): Promise<unknown> => {
                if (signal.aborted || options.signal?.aborted) throw signal.reason ?? options.signal?.reason ?? new Error('PTC aborted')
                const callId = `${parentCallId}/ptc/${randomUUID()}`
                const childOptions: ToolExecuteOptions = {
                  callId,
                  ...(options.agentId ? { agentId: options.agentId } : {}),
                  signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
                  ptcParentCallId: parentCallId,
                }
                await session?.append('meta', {
                  kind: 'ptc/dispatch-start', parentCallId, callId, name: tool.schema.name,
                  input: bounded(input, maxResultChars),
                })
                await session?.flush()
                const result = await registry.execute(tool.schema.name, input, childOptions)
                await session?.append('meta', {
                  kind: 'ptc/dispatch', parentCallId, callId, name: tool.schema.name,
                  ok: result.ok,
                  result: bounded({ ...result, input: undefined }, maxResultChars),
                })
                await session?.flush()
                if (result.concludesTurn || childOptions.concludesTurn) options.concludesTurn = true
                if (!result.ok) throw new Error(renderToolResult(result))
                return bounded(result.output, maxResultChars)
              }
              const result = queue.then(execute)
              queue = result.then(() => undefined, () => undefined)
              return result
            },
          }))
        try {
          const result = await ctx.ptcRuntime.execute({
            code: input.code,
            tools: bindings,
            ...(options.signal ? { signal: options.signal } : {}),
          })
          if (!result.ok) {
            const output = renderToolResult({ ok: true, output: result.output }).slice(0, maxResultChars)
            throw new PtcExecutionError(`PTC execution failed: ${(result.error ?? 'unknown error').slice(0, maxResultChars)}\nOutput: ${output}`)
          }
          return { ...result, ...(result.value !== undefined ? { value: bounded(result.value, maxResultChars) } : {}) }
        } finally {
          // Drain cancelled or unawaited child work before the outer call closes.
          await queue
        }
      },
    })
    ctx.on('agent/request', (request: AgentRequestEvent): AgentRequestEvent => {
      const names = registry.list().filter(tool => tool.schema.name !== 'run_code'
        && tool.metadata?.ptc !== false).map(tool => tool.schema.name)
      return {
        ...request,
        tools: request.tools.filter(tool => mode !== 'ptc' || tool.schema.name === 'run_code').map(tool =>
          tool.schema.name !== 'run_code' ? tool : {
            ...tool,
            schema: {
              ...tool.schema,
              description: tool.schema.description + ` Available tools: ${JSON.stringify(names)}. First inspect the description and input schema of every unfamiliar tool with text(ALL_TOOLS.filter(t => t.name === 'tool_name')). ALL_TOOLS is a discovery list, not executable functions; schemas are in description, not a parameters property.`,
            },
          }),
      }
    })
    if (mode === 'ptc') {
      registry.guard(request => request.name === 'run_code' || typeof request.options.ptcParentCallId === 'string'
        ? undefined : 'Native tool calls are disabled in PTC mode')
    }
  },
}

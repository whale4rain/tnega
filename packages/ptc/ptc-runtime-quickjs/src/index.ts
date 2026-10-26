import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CodemodeSandbox, loadQuickJSWasm } from '@earendil-works/pi-codemode'
import type { Context } from '@tnega/core'
import { PtcRuntimeService, type PtcRequest, type PtcResult } from '@tnega/ptc-runtime'

export interface PtcRuntimeQuickjsConfig {
  timeoutMs?: number
  memoryLimitBytes?: number
  maxOutputChars?: number
  maxCalls?: number
  workerUrl?: URL
  wasmPath?: string
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

export class QuickjsPtcRuntime extends PtcRuntimeService {
  private readonly active = new Set<CodemodeSandbox>()
  private readonly pendingBindings = new Set<Promise<unknown>>()
  private readonly timeoutMs: number
  private readonly memoryLimitBytes: number
  private readonly maxOutputChars: number
  private readonly maxCalls: number

  constructor(ctx: Context, private readonly config: PtcRuntimeQuickjsConfig = {}) {
    super(ctx)
    this.timeoutMs = positive(config.timeoutMs ?? 300_000, 'timeoutMs')
    this.memoryLimitBytes = positive(config.memoryLimitBytes ?? 64 * 1024 * 1024, 'memoryLimitBytes')
    this.maxOutputChars = positive(config.maxOutputChars ?? 64_000, 'maxOutputChars')
    this.maxCalls = positive(config.maxCalls ?? 100, 'maxCalls')
    ctx.effect(() => async () => {
      await Promise.all([...this.active].map(sandbox => sandbox.close()))
      await Promise.allSettled([...this.pendingBindings])
    })
  }

  override async execute(request: PtcRequest): Promise<PtcResult> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('PTC aborted')
    const controller = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
    let calls = 0
    const pendingBindings = new Set<Promise<unknown>>()
    const packagedWorker = new URL('./ptc-worker.js', import.meta.url)
    const packagedWasm = new URL('./quickjs.wasm', import.meta.url)
    const workerUrl = this.config.workerUrl ?? (existsSync(packagedWorker) ? packagedWorker : new URL('./worker.mjs', import.meta.url))
    const wasmPath = this.config.wasmPath ?? (existsSync(packagedWasm) ? fileURLToPath(packagedWasm) : undefined)
    const sandbox = new CodemodeSandbox({
      timeoutMs: this.timeoutMs,
      memoryLimitBytes: this.memoryLimitBytes,
      ...(workerUrl ? { workerUrl } : {}),
      ...(wasmPath ? { wasm: loadQuickJSWasm(wasmPath) } : {}),
      tools: request.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        execute: async (input, context) => {
          if (++calls > this.maxCalls) {
            controller.abort(new Error('PTC tool call limit exceeded'))
            throw new Error('PTC tool call limit exceeded')
          }
          const pending = tool.execute(input, context.signal)
          pendingBindings.add(pending)
          this.pendingBindings.add(pending)
          try {
            return await pending
          } finally {
            pendingBindings.delete(pending)
            this.pendingBindings.delete(pending)
          }
        },
      })),
    })
    this.active.add(sandbox)
    try {
      const result = await sandbox.execute(request.code, { signal })
      const output = result.output.filter(item => item.type === 'text').map(item => item.text)
      if (output.reduce((sum, item) => sum + item.length, 0) > this.maxOutputChars) {
        return { ok: false, error: 'PTC output limit exceeded', output: [] }
      }
      return result.ok
        ? { ok: true, value: result.value, output }
        : { ok: false, error: result.error.message, output }
    } finally {
      await sandbox.close()
      await Promise.allSettled([...pendingBindings])
      this.active.delete(sandbox)
    }
  }
}

export const ptcRuntimeQuickjs = {
  name: 'ptc-runtime-quickjs',
  apply(ctx: Context, config: PtcRuntimeQuickjsConfig = {}): void {
    new QuickjsPtcRuntime(ctx, config)
  },
}

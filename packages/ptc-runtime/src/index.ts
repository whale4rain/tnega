import { Service, type Context } from '@tnega/core'

export interface PtcBinding {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(input: unknown, signal: AbortSignal): Promise<unknown>
}

export interface PtcRequest {
  code: string
  tools: readonly PtcBinding[]
  signal?: AbortSignal
}

export interface PtcResult {
  ok: boolean
  value?: unknown
  output: readonly string[]
  error?: string
}

declare module '@tnega/core' {
  interface Context {
    ptcRuntime: PtcRuntimeService
  }
}

/** Pure execution seam: knows neither the tool registry nor Sessions. */
export abstract class PtcRuntimeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ptcRuntime')
  }

  abstract execute(request: PtcRequest): Promise<PtcResult>
}

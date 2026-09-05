import type { Context, Plugin } from '@tnega/core'
import type { LLMAdapter } from './types.js'

export interface LlmRouteCapacity {
  provider: string
  model: string
  contextWindow?: number
}

export class LlmService {
  private _adapters = new Map<string, LLMAdapter>()
  private _current: LLMAdapter | undefined
  private _defaultName: string | undefined

  register(name: string, adapter: LLMAdapter): () => void {
    const key = name.trim()
    if (!key) throw new TypeError('llm provider requires a non-empty name')
    if (this._adapters.has(key)) throw new Error(`llm provider already registered: ${key}`)
    this._adapters.set(key, adapter)
    if (!this._current) {
      this._current = adapter
      this._defaultName = key
    }
    return () => {
      this._adapters.delete(key)
      if (this._defaultName === key) {
        this._defaultName = undefined
        this._current = this._adapters.values().next().value
      }
    }
  }

  setCurrent(name: string): LLMAdapter {
    const adapter = this._adapters.get(name.trim())
    if (!adapter) throw new Error(`llm provider not found: ${name}`)
    this._current = adapter
    this._defaultName = name.trim()
    return adapter
  }

  current(): LLMAdapter | undefined {
    return this._current
  }

  list(): readonly { name: string; adapter: LLMAdapter }[] {
    return [...this._adapters.entries()].map(([name, adapter]) => ({ name, adapter }))
  }

  /**
   * Report provider/model/contextWindow for the current route. The adapter
   * may be registered with an optional capacity provider by callers that own
   * the model catalog (for example the CLI runtime).
   */
  routeCapacity(): LlmRouteCapacity | undefined {
    if (!this._current || !this._defaultName) return undefined
    const provider = this._defaultName
    const model = (this._current as unknown as { model?: string }).model
    const contextWindow = this._capacityFor?.(model)
    const result: LlmRouteCapacity = { provider, model: model ?? '' }
    if (contextWindow !== undefined) result.contextWindow = contextWindow
    return result
  }

  private _capacityFor: ((model: string | undefined) => number | undefined) | undefined

  /** Install a catalog-backed contextWindow resolver (optional). */
  setCapacityResolver(resolver: (model: string | undefined) => number | undefined): void {
    this._capacityFor = resolver
  }
}

export const llmService = {
  name: 'llm-service',
  apply: (ctx: Context) => {
    ctx.provide('llm', new LlmService())
    return () => {}
  },
} satisfies Plugin

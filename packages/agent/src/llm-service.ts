import type { Context, Plugin } from '@tnega/core'
import type { LLMAdapter } from './types.js'

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
}

export const llmService = {
  name: 'llm-service',
  apply: (ctx: Context) => {
    ctx.provide('llm', new LlmService())
    return () => {}
  },
} satisfies Plugin

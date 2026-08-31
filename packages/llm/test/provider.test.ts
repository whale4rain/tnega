import { describe, expect, it } from 'vitest'

import {
  createLlmAdapter,
  DEFAULT_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  lookupModel,
  MODEL_CATALOG,
} from '../src/index.js'

describe('createLlmAdapter', () => {
  it('routes minimax-m3 to the Anthropic Messages adapter', () => {
    const adapter = createLlmAdapter({ model: 'minimax-m3' })
    expect(adapter).toBeDefined()
    expect(lookupModel('minimax-m3')?.protocol).toBe('anthropic')
    expect(lookupModel('MINIMAX-M3')?.protocol).toBe('anthropic')
    expect(DEFAULT_MODEL).toBe('minimax-m3')
  })

  it('routes deepseek models to the OpenAI compatible adapter', () => {
    expect(lookupModel('deepseek-v4-flash')?.protocol).toBe('openai')
    expect(lookupModel('deepseek-v4-pro')?.protocol).toBe('openai')
    expect(DEFAULT_DEEPSEEK_MODEL).toBe('deepseek-v4-flash')
  })

  it('falls back to OpenAI for unknown models', () => {
    expect(lookupModel('mock-model')).toBeUndefined()
    expect(lookupModel(undefined)).toBeUndefined()
  })

  it('keeps pricing out of the capability table', () => {
    for (const model of MODEL_CATALOG) {
      expect('price' in model).toBe(false)
      expect('pricing' in model).toBe(false)
      expect('costPerToken' in model).toBe(false)
      expect(typeof model.contextWindow).toBe('number')
    }
  })
})

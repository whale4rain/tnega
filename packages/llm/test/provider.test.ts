import { describe, expect, it } from 'vitest'

import {
  createLlmAdapter,
  DEFAULT_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  lookupModel,
  MODEL_CATALOG,
} from '../src/index.js'

function expectPricingPositive(
  pricing: { input: number; output: number; cachedRead?: number },
  label: string,
) {
  expect(pricing.input, `${label} input`).toBeGreaterThan(0)
  expect(Number.isFinite(pricing.input), `${label} input finite`).toBe(true)
  expect(pricing.output, `${label} output`).toBeGreaterThan(0)
  expect(Number.isFinite(pricing.output), `${label} output finite`).toBe(true)
  if (pricing.cachedRead !== undefined) {
    expect(pricing.cachedRead, `${label} cachedRead`).toBeGreaterThan(0)
    expect(Number.isFinite(pricing.cachedRead), `${label} cachedRead finite`).toBe(
      true,
    )
  }
}

describe('createLlmAdapter', () => {
  it('routes the default deepseek model to the OpenAI compatible adapter', () => {
    const adapter = createLlmAdapter({})
    expect(adapter).toBeDefined()
    expect(DEFAULT_MODEL).toBe('deepseek-v4-flash')
    expect(lookupModel(DEFAULT_MODEL)?.protocol).toBe('openai')
  })

  it('routes minimax-m3 to the Anthropic Messages adapter', () => {
    expect(createLlmAdapter({ model: 'minimax-m3' })).toBeDefined()
    expect(lookupModel('minimax-m3')?.protocol).toBe('anthropic')
    expect(lookupModel('MINIMAX-M3')?.protocol).toBe('anthropic')
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

  it('keeps positive pricing metadata in the capability table', () => {
    for (const model of MODEL_CATALOG) {
      expect(typeof model.contextWindow).toBe('number')
      expect(model.pricing).toBeDefined()
      expect(model.pricing.monthlyUsage, `${model.id} monthlyUsage`).toBeGreaterThan(0)
      if ('peak' in model.pricing.rates) {
        expectPricingPositive(model.pricing.rates.offPeak, `${model.id} off-peak`)
        expectPricingPositive(model.pricing.rates.peak, `${model.id} peak`)
      } else {
        expectPricingPositive(model.pricing.rates, model.id)
      }
    }
  })

  it('records official OpenCode Go rates for minimax-m3', () => {
    const minimax = lookupModel('minimax-m3')
    expect(minimax?.pricing).toEqual({
      rates: {
        input: 0.3,
        output: 1.2,
        cachedRead: 0.06,
      },
      monthlyUsage: 60,
    })
  })

  it('records official OpenCode Go peak and off-peak rates for deepseek', () => {
    const flash = lookupModel('deepseek-v4-flash')
    expect(flash?.pricing).toEqual({
      rates: {
        offPeak: {
          input: 0.22,
          output: 0.66,
          cachedRead: 0.007,
        },
        peak: {
          input: 0.44,
          output: 1.32,
          cachedRead: 0.014,
        },
      },
      monthlyUsage: 30,
    })

    const pro = lookupModel('deepseek-v4-pro')
    expect(pro?.pricing).toEqual({
      rates: {
        offPeak: {
          input: 0.66,
          output: 1.98,
          cachedRead: 0.022,
        },
        peak: {
          input: 1.32,
          output: 3.96,
          cachedRead: 0.044,
        },
      },
      monthlyUsage: 15,
    })
  })
})

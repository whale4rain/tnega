export type LlmProtocol = 'openai' | 'anthropic'

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cached input tokens, when the provider publishes a rate */
  cachedRead?: number
}

export interface ModelPricingMeta {
  /** USD per 1M tokens for peak / off-peak tiers */
  rates: ModelPricing | {
    offPeak: ModelPricing
    peak: ModelPricing
  }
  /** USD usage allowance included in the OpenCode Go subscription */
  monthlyUsage: number
}

export interface ModelDefinition {
  id: string
  provider: 'opencode-go'
  protocol: LlmProtocol
  contextWindow: number
  pricing: ModelPricingMeta
}

export const DEFAULT_MODEL = 'minimax-m3'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

export const MODEL_CATALOG: readonly ModelDefinition[] = [
  {
    id: 'minimax-m3',
    provider: 'opencode-go',
    protocol: 'anthropic',
    contextWindow: 1_000_000,
    pricing: {
      rates: {
        input: 0.3,
        output: 1.2,
        cachedRead: 0.06,
      },
      monthlyUsage: 60,
    },
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'opencode-go',
    protocol: 'openai',
    contextWindow: 1_000_000,
    pricing: {
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
    },
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'opencode-go',
    protocol: 'openai',
    contextWindow: 1_000_000,
    pricing: {
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
    },
  },
]

export function lookupModel(id: string | undefined): ModelDefinition | undefined {
  if (!id) return undefined
  const normalized = id.trim().toLowerCase()
  return MODEL_CATALOG.find(model => model.id === normalized)
}

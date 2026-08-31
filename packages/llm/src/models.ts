export type LlmProtocol = 'openai' | 'anthropic'

export interface ModelDefinition {
  id: string
  provider: 'opencode-go'
  protocol: LlmProtocol
  contextWindow: number
}

export const DEFAULT_MODEL = 'minimax-m3'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

export const MODEL_CATALOG: readonly ModelDefinition[] = [
  {
    id: 'minimax-m3',
    provider: 'opencode-go',
    protocol: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'opencode-go',
    protocol: 'openai',
    contextWindow: 1_000_000,
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'opencode-go',
    protocol: 'openai',
    contextWindow: 1_000_000,
  },
]

export function lookupModel(id: string | undefined): ModelDefinition | undefined {
  if (!id) return undefined
  const normalized = id.trim().toLowerCase()
  return MODEL_CATALOG.find(model => model.id === normalized)
}

import type { Context, Plugin } from '@tnega/core'

export interface PromptSection {
  name: string
  order?: number
  content: string
}

export interface SystemPromptAssemblyOptions {
  scope?: unknown
  [key: string]: unknown
}

export interface PromptAssembly {
  sections: readonly PromptSection[]
  text: string
  context?: SystemPromptAssemblyOptions
  tools?: readonly { name: string; description: string; parameters?: Record<string, unknown> }[]
}

export type ToolSchemaSnapshot = {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

export type ToolSchemaProvider = (
  context: SystemPromptAssemblyOptions,
) => readonly ToolSchemaSnapshot[] | Promise<readonly ToolSchemaSnapshot[]>

export class SystemPromptService {
  private _sections = new Map<string, PromptSection>()
  private _toolProviders: ToolSchemaProvider[] = []
  private _ctx: Context | undefined

  constructor(ctx?: Context) {
    this._ctx = ctx
  }

  registerSection(section: PromptSection): () => void {
    const name = section.name.trim()
    if (!name) throw new TypeError('prompt section requires a non-empty name')
    if (this._sections.has(name)) {
      throw new Error(`prompt section already registered: ${name}`)
    }
    this._sections.set(name, { ...section, name })
    this._emitChange()
    return () => {
      this._sections.delete(name)
      this._emitChange()
    }
  }

  sections(): readonly PromptSection[] {
    return [...this._sections.values()]
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  }

  registerTools(provider: ToolSchemaProvider): () => void {
    if (typeof provider !== 'function') throw new TypeError('tool provider must be a function')
    this._toolProviders.push(provider)
    this._emitChange()
    return () => {
      const index = this._toolProviders.indexOf(provider)
      if (index >= 0) this._toolProviders.splice(index, 1)
      this._emitChange()
    }
  }

  async toolSchemas(options: SystemPromptAssemblyOptions = {}): Promise<ToolSchemaSnapshot[]> {
    const seen = new Set<string>()
    const tools: ToolSchemaSnapshot[] = []
    for (const provider of this._toolProviders) {
      for (const schema of await provider(options)) {
        if (!seen.has(schema.name)) {
          seen.add(schema.name)
          tools.push(schema)
        }
      }
    }
    return tools
  }

  async assemble(
    options: SystemPromptAssemblyOptions = {},
    ctx?: Context,
  ): Promise<PromptAssembly> {
    const activeCtx = ctx ?? this._ctx
    const sections = this.sections()
    const base: PromptAssembly = {
      sections,
      text: sections.map(section => section.content).filter(Boolean).join('\n\n'),
      ...(Object.keys(options).length ? { context: options } : {}),
    }
    const tools = await this.toolSchemas(options)
    if (tools.length) base.tools = tools
    if (!activeCtx) return base
    const resolved = await activeCtx.waterfallAsync(
      'system-prompt/assemble',
      base,
      async (assembly: PromptAssembly) => assembly,
    )
    return resolved ?? base
  }

  private _emitChange(): void {
    this._ctx?.emit('system-prompt/change')
  }
}

export const systemPrompt = {
  name: 'system-prompt',
  apply: (ctx: Context) => {
    const service = new SystemPromptService(ctx)
    ctx.provide('systemPrompt', service)
    return () => {}
  },
} satisfies Plugin

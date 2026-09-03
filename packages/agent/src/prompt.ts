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
}

export class SystemPromptService {
  private _sections = new Map<string, PromptSection>()
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

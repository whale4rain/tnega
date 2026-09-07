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
  variables?: Record<string, string>
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

export type PromptVariableProvider = (
  context: SystemPromptAssemblyOptions,
) => string | undefined | Promise<string | undefined>

export interface PromptContextProvider {
  name: string
  order?: number
  content: PromptVariableProvider
}

export class SystemPromptService {
  private _sections = new Map<string, PromptSection>()
  private _toolProviders: ToolSchemaProvider[] = []
  private _variables = new Map<string, PromptVariableProvider>()
  private _contexts: PromptContextProvider[] = []
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

  registerVariable(name: string, provider: PromptVariableProvider): () => void {
    const key = name.trim()
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
      throw new TypeError(`invalid prompt variable name: ${name}`)
    }
    if (typeof provider !== 'function') throw new TypeError('variable provider must be a function')
    if (this._variables.has(key)) throw new Error(`prompt variable already registered: ${key}`)
    this._variables.set(key, provider)
    this._emitChange()
    return () => {
      this._variables.delete(key)
      this._emitChange()
    }
  }

  registerContext(context: PromptContextProvider): () => void {
    const name = context.name.trim()
    if (!name) throw new TypeError('prompt context requires a non-empty name')
    if (this._contexts.some(entry => entry.name === name)) {
      throw new Error(`prompt context already registered: ${name}`)
    }
    this._contexts.push({ ...context, name })
    this._emitChange()
    return () => {
      this._contexts = this._contexts.filter(entry => entry.name !== name)
      this._emitChange()
    }
  }

  async assemble(
    options: SystemPromptAssemblyOptions = {},
    ctx?: Context,
  ): Promise<PromptAssembly> {
    const activeCtx = ctx ?? this._ctx
    const sections = this.sections()
    const variables = await this._resolveVariables(options)
    const renderedSections = sections.map(section => ({
      ...section,
      content: renderTemplate(section.content, variables),
    }))
    const dynamicContexts = await this._resolveContexts(options)
    const contextText = dynamicContexts
      .map(context => renderTemplate(context.content, variables))
      .filter(Boolean)
    const base: PromptAssembly = {
      sections: renderedSections,
      text: [
        ...renderedSections.map(section => section.content).filter(Boolean),
        ...contextText,
      ].join('\n\n'),
      ...(Object.keys(variables).length ? { variables } : {}),
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

  private async _resolveVariables(
    options: SystemPromptAssemblyOptions,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const [name, provider] of this._variables) {
      const value = await provider(options)
      if (value !== undefined) result[name] = value
    }
    return result
  }

  private async _resolveContexts(
    options: SystemPromptAssemblyOptions,
  ): Promise<readonly { name: string; content: string }[]> {
    const contexts = this._contexts.slice()
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    const result: Array<{ name: string; content: string }> = []
    for (const context of contexts) {
      const value = await context.content(options)
      if (value) result.push({ name: context.name, content: value })
    }
    return result
  }

  private _emitChange(): void {
    this._ctx?.emit('system-prompt/change')
  }
}

function renderTemplate(text: string, variables: Record<string, string>): string {
  return text.replace(/\$\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    return variables[name] ?? match
  })
}

export const systemPrompt = {
  name: 'system-prompt',
  apply: (ctx: Context) => {
    const service = new SystemPromptService(ctx)
    ctx.provide('systemPrompt', service)
    return () => {}
  },
} satisfies Plugin

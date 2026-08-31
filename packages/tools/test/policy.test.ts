import { describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import {
  ToolsService,
  tools,
  validateSchema,
  validateToolInput,
  type ToolAuthorizer,
  type ToolDefinition,
  type ToolInputValidator,
  type ToolRequest,
  type ToolResult,
  type ToolResultTruncator,
  type ToolStagePayload,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

function simpleTool(name = 'simple'): ToolDefinition {
  return {
    schema: { name, description: 'simple' },
    execute: (input) => input,
  }
}

describe('schema validator', () => {
  it('accepts valid inputs and properties without an explicit type', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { description: 'any JSON value' },
      },
      required: ['name'],
    }

    expect(validateSchema({ name: 'ok', value: [1, 2, 3] }, schema)).toEqual([])
    expect(validateSchema({ name: 'ok' }, schema)).toEqual([])
  })

  it('reports missing required, wrong types and enum violations', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'safe'] },
        nested: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
          },
        },
      },
      required: ['name'],
    }

    expect(validateSchema({}, schema)).toContain('missing required property: name')
    expect(validateSchema({ name: 1 }, schema)).toContain('name.expected string, received number')
    expect(validateSchema({ name: 'x', mode: 'risky' }, schema))
      .toContain('mode must be one of fast, safe')
    expect(validateSchema({
      name: 'x',
      nested: { count: 'not-an-integer' },
    }, schema)).toContain('nested.count.expected integer, received string')
  })

  it('validates tool input without requiring a type on every property', () => {
    const tool: ToolDefinition = {
      schema: {
        name: 'json_any',
        description: 'accepts any value',
        parameters: {
          type: 'object',
          properties: {
            value: { description: 'anything' },
          },
        },
      },
      execute: () => 'ok',
    }

    expect(() => validateToolInput({ value: { nested: true } }, tool)).not.toThrow()
    expect(() => validateToolInput({}, tool)).not.toThrow()
  })
})

describe('tool policies', () => {
  it('rejects invalid input through the default schema validator', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    let executed = false
    service.register({
      schema: {
        name: 'greet',
        description: 'greet someone',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      execute: () => {
        executed = true
        return 'hello'
      },
    })

    const result = await service.execute('greet', {})
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('missing required property: name')
    expect(executed).toBe(false)
  })

  it('runs a custom validator before the executor', async () => {
    const root = new Context()
    await root.plugin(tools, {
      validator: ((input: unknown) => {
        if ((input as { deny?: boolean }).deny) throw new Error('denied by validator')
      }) satisfies ToolInputValidator,
    })
    const service = dynamic(root).tools as ToolsService
    let executed = false
    service.register({
      schema: { name: 'guarded', description: 'guarded' },
      execute: () => {
        executed = true
        return 'ok'
      },
    })

    const result = await service.execute('guarded', { deny: true })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('denied by validator')
    expect(executed).toBe(false)
  })

  it('denies tools through an authorizer without invoking the executor', async () => {
    const root = new Context()
    await root.plugin(tools, {
      authorizer: (async (request: ToolRequest) => request.name === 'safe') satisfies ToolAuthorizer,
    })
    const service = dynamic(root).tools as ToolsService
    let unsafeExecuted = false
    service.register(simpleTool('safe'))
    service.register({
      schema: { name: 'unsafe', description: 'unsafe' },
      execute: () => {
        unsafeExecuted = true
        return 'bad'
      },
    })

    expect((await service.execute('safe', {})).ok).toBe(true)
    const denied = await service.execute('unsafe', {})
    expect(denied.ok).toBe(false)
    expect(denied.error?.name).toBe('ToolAuthorizationError')
    expect(unsafeExecuted).toBe(false)
  })

  it('truncates successful output before result hooks', async () => {
    const root = new Context()
    let seen: ToolResult | undefined
    root.on('tools/result', (payload: ToolStagePayload) => {
      seen = payload.result
    })
    await root.plugin(tools, {
      truncator: (async (result: ToolResult) => {
        if (typeof result.output === 'string') {
          return { ...result, output: result.output.slice(0, 3) }
        }
        return result
      }) satisfies ToolResultTruncator,
    })
    const service = dynamic(root).tools as ToolsService
    service.register({
      schema: { name: 'long', description: 'long' },
      execute: () => 'abcdef',
    })

    const result = await service.execute('long', {})
    expect(result.output).toBe('abc')
    expect(seen?.output).toBe('abc')
  })

  it('lets per-tool policies override global policies', async () => {
    const root = new Context()
    await root.plugin(tools, {
      authorizer: async () => false,
      truncator: (async (result: ToolResult) => ({
        ...result,
        output: String(result.output).slice(0, 3),
      })) satisfies ToolResultTruncator,
    })
    const service = dynamic(root).tools as ToolsService
    service.register({
      schema: { name: 'overridden', description: 'overridden' },
      policy: {
        authorizer: async () => true,
        truncator: async (result) => ({
          ...result,
          output: String(result.output).slice(0, 2),
        }),
      },
      execute: () => 'abcdef',
    })

    const result = await service.execute('overridden', {})
    expect(result.ok).toBe(true)
    expect(result.output).toBe('ab')
  })
})

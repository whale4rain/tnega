import { describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import {
  ToolAlreadyRegisteredError,
  ToolNotFoundError,
  ToolsService,
  tools,
  type ToolDefinition,
  type ToolRequest,
  type ToolResult,
  type ToolStagePayload,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

function addTool(): ToolDefinition {
  return {
    schema: { name: 'add', description: 'add two numbers' },
    execute: (input) => {
      const values = input as { a: number; b: number }
      return values.a + values.b
    },
  }
}

describe('ToolsService registry', () => {
  it('registers, lists, checks and unregisters tools', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService

    expect(service.has('add')).toBe(false)
    const dispose = service.register(addTool())
    expect(service.has('add')).toBe(true)
    expect(service.list().map(tool => tool.schema.name)).toEqual(['add'])
    expect(service.toSpecs()).toEqual([{ name: 'add', description: 'add two numbers' }])

    dispose()
    expect(service.has('add')).toBe(false)
  })

  it('rejects duplicate tools in the same scope', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    service.register(addTool())

    expect(() => service.register(addTool())).toThrow(ToolAlreadyRegisteredError)
  })

  it('throws ToolNotFoundError for unknown tools', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService

    await expect(service.execute('missing', {})).rejects.toThrow(ToolNotFoundError)
  })

  it('validates definitions before registration', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService

    expect(() => service.register({ schema: { name: '', description: 'x' }, execute: () => {} }))
      .toThrow(TypeError)
    expect(() => service.register({
      schema: { name: 'bad', description: 'x' },
      execute: undefined as never,
    })).toThrow(TypeError)
  })
})

describe('ToolsService pipeline', () => {
  it('runs pre-execute, execute, executor, post-execute and result in order', async () => {
    const root = new Context()
    await root.plugin(tools)
    const order: string[] = []
    root.on('tools/pre-execute', (request: ToolRequest) => {
      order.push('pre')
      request.input = { a: 10, b: 20 }
    })
    root.on('tools/execute', () => {
      order.push('execute')
    })
    root.on('tools/post-execute', (payload: ToolStagePayload) => {
      order.push(`post:${payload.result.ok}`)
    })
    root.on('tools/result', (payload: ToolStagePayload) => {
      order.push('result')
      payload.result.output = `wrapped:${String(payload.result.output)}`
    })

    const service = dynamic(root).tools as ToolsService
    service.register({
      schema: { name: 'add', description: 'add' },
      execute: async (input) => {
        order.push('executor')
        const values = input as { a: number; b: number }
        return values.a + values.b
      },
    })

    const result = await service.execute('add', { a: 1, b: 2 })
    expect(order).toEqual(['pre', 'execute', 'executor', 'post:true', 'result'])
    expect(result.output).toBe('wrapped:30')
  })

  it('keeps post-execute and result running when the executor throws', async () => {
    const root = new Context()
    await root.plugin(tools)
    const order: string[] = []
    root.on('tools/post-execute', (payload: ToolStagePayload) => {
      order.push(`post:${payload.result.ok}`)
    })
    root.on('tools/result', (payload: ToolStagePayload) => {
      order.push(`result:${payload.result.error?.message ?? 'none'}`)
    })

    const service = dynamic(root).tools as ToolsService
    service.register({
      schema: { name: 'fail', description: 'fail' },
      execute: () => {
        throw new Error('boom')
      },
    })

    const result = await service.execute('fail', {})
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('boom')
    expect(order).toEqual(['post:false', 'result:boom'])
  })

  it('passes callId through to the result', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    service.register(addTool())

    const result = await service.execute('add', { a: 1, b: 2 }, { callId: 'c1' })
    expect(result.callId).toBe('c1')
  })
})

describe('ToolsService scope', () => {
  it('keeps tools isolated between different scopes', async () => {
    const root = new Context()
    const scopeA = root.isolate('tools')
    const scopeB = root.isolate('tools')
    await Promise.all([scopeA.plugin(tools), scopeB.plugin(tools)])

    const serviceA = dynamic(scopeA).tools as ToolsService
    const serviceB = dynamic(scopeB).tools as ToolsService
    serviceA.register({
      schema: { name: 'only-a', description: 'a' },
      execute: () => 'a',
    })
    serviceB.register({
      schema: { name: 'only-b', description: 'b' },
      execute: () => 'b',
    })

    expect(serviceA.has('only-a')).toBe(true)
    expect(serviceA.has('only-b')).toBe(false)
    expect(serviceB.has('only-a')).toBe(false)
    expect(serviceB.has('only-b')).toBe(true)
  })

  it('removes registrations when the registering fiber unloads', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService

    const fiber = root.plugin({
      inject: ['tools'],
      apply: (ctx) => {
        const scoped = dynamic(ctx).tools as ToolsService
        scoped.register({
          schema: { name: 'scoped', description: 'scoped' },
          execute: () => 'ok',
        })
      },
    })
    await fiber
    expect(service.has('scoped')).toBe(true)

    await fiber.dispose()
    expect(service.has('scoped')).toBe(false)
  })

  it('unloads a tools plugin without touching another scope', async () => {
    const root = new Context()
    const scopeA = root.isolate('tools')
    const scopeB = root.isolate('tools')
    const fiberA = scopeA.plugin(tools)
    await Promise.all([fiberA, scopeB.plugin(tools)])

    const serviceA = dynamic(scopeA).tools as ToolsService
    const serviceB = dynamic(scopeB).tools as ToolsService
    serviceA.register({
      schema: { name: 'temp', description: 'temp' },
      execute: () => 'temp',
    })
    expect(serviceA.has('temp')).toBe(true)

    await fiberA.dispose()
    expect(dynamic(scopeA).tools).toBeUndefined()
    expect(serviceB.has('temp')).toBe(false)
    expect(dynamic(scopeB).tools).toBeDefined()
  })

  it('keeps failed tool results isolated to the executing scope', async () => {
    const root = new Context()
    const scopeA = root.isolate('tools')
    const scopeB = root.isolate('tools')
    await Promise.all([scopeA.plugin(tools), scopeB.plugin(tools)])
    const serviceA = dynamic(scopeA).tools as ToolsService
    const serviceB = dynamic(scopeB).tools as ToolsService

    serviceA.register({
      schema: { name: 'boom', description: 'boom' },
      execute: () => {
        throw new Error('only a')
      },
    })
    const result = await serviceA.execute('boom', {})
    expect(result).toMatchObject({ ok: false, error: { message: 'only a' } })
    expect(serviceB.has('boom')).toBe(false)
  })
})

describe('ToolsService result shape', () => {
  it('reports duration and output for a successful call', async () => {
    const root = new Context()
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    service.register(addTool())

    const result = await service.execute('add', { a: 1, b: 2 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe(3)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.startedAt).toBeLessThanOrEqual(Date.now())
  })

  it('returns the same result object from the result stage', async () => {
    const root = new Context()
    await root.plugin(tools)
    let seen: ToolResult | undefined
    root.on('tools/result', (payload: ToolStagePayload) => {
      seen = payload.result
    })
    const service = dynamic(root).tools as ToolsService
    service.register(addTool())

    const result = await service.execute('add', { a: 1, b: 2 })
    expect(seen).toBe(result)
  })
})

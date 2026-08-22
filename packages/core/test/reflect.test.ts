import { describe, expect, it } from 'vitest'

import { Context, FiberState } from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

describe('ReflectService', () => {
  it('provides, gets and sets services', () => {
    const root = new Context()
    root.provide('answer', 42)

    expect(root.get('answer')).toBe(42)
    expect(dynamic(root).answer).toBe(42)

    root.set('answer', 43)
    expect(root.get('answer')).toBe(43)
  })

  it('removes a service when the provide disposer runs', () => {
    const root = new Context()
    const dispose = root.provide('temp', 1)
    expect(root.get('temp')).toBe(1)

    dispose()
    expect(root.get('temp')).toBeUndefined()
  })

  it('rejects duplicate provides in the same scope', () => {
    const root = new Context()
    root.provide('dup', 1)
    expect(() => root.provide('dup', 2)).toThrow(/has been registered/)
  })

  it('rejects setting a service that was never provided', () => {
    const root = new Context()
    expect(() => root.set('missing', 1)).toThrow(/without provide/)
  })

  it('isolates services by scope', () => {
    const root = new Context()
    root.provide('answer', 42)
    const child = root.isolate('answer')
    child.provide('answer', 1)

    expect(child.get('answer')).toBe(1)
    expect(root.get('answer')).toBe(42)
  })

  it('registers and removes accessors', () => {
    const root = new Context()
    const dispose = root.accessor('computed', {
      get: () => 'value',
    })

    expect(dynamic(root).computed).toBe('value')
    dispose()
    expect(dynamic(root).computed).toBeUndefined()
  })

  it('rejects accessor name conflicts', () => {
    const root = new Context()
    root.accessor('same', { get: () => 1 })
    expect(() => root.accessor('same', { get: () => 2 })).toThrow(/already declared/)
  })

  it('mixes service methods and properties onto the context', () => {
    const root = new Context()
    const calc = {
      add: (left: number, right: number) => left + right,
      version: 1,
    }
    root.provide('calc', calc)
    root.mixin('calc', ['add', 'version'])

    expect((dynamic(root).add as (left: number, right: number) => number)(1, 2)).toBe(3)
    expect(dynamic(root).version).toBe(1)
  })

  it('keeps child fiber services invisible to the parent', async () => {
    const root = new Context()
    const scope = root.isolate('childService')
    const child = scope.plugin((ctx) => {
      ctx.provide('childService', 1)
    })
    await child

    expect(child.ctx.get('childService')).toBe(1)
    expect(root.get('childService')).toBeUndefined()
  })

  it('resolves parent services from child fibers', async () => {
    const root = new Context()
    root.provide('parentService', 1)
    const child = root.plugin((ctx) => {
      expect(ctx.get('parentService')).toBe(1)
    })
    await child
  })

  it('lets internal/get hooks intercept property access', async () => {
    const root = new Context()
    root.on('internal/get', function (this: Context, name: string, _error: Error, next: () => unknown) {
      if (name === 'magic') return 'hooked'
      return next()
    })

    const fiber = root.plugin((ctx) => {
      expect(dynamic(ctx).magic).toBe('hooked')
    })
    await fiber
  })

  it('lets internal/set hooks intercept property assignment', async () => {
    const root = new Context()
    const values: number[] = []
    root.on('internal/set', function (this: Context, name: string, value: number, _error: Error, next: () => boolean) {
      if (name === 'magic') {
        values.push(value)
        return true
      }
      return next()
    })

    const fiber = root.plugin((ctx) => {
      dynamic(ctx).magic = 7
    })
    await fiber
    expect(values).toEqual([7])
  })

  it('re-evaluates check when notify runs', async () => {
    const root = new Context()
    let healthy = false
    root.provide('flag', true, () => healthy)

    const fiber = root.plugin({
      inject: ['flag'],
      apply: () => {},
    })
    await fiber
    expect(fiber.state).toBe(FiberState.PENDING)

    healthy = true
    root.reflect.notify(['flag'])
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('emits internal/service during notify', () => {
    const root = new Context()
    root.provide('svc', 1)
    const seen: Array<[string, unknown]> = []
    root.on('internal/service', function (this: Context, name: string, value: unknown) {
      seen.push([name, value])
    })

    root.set('svc', 2)
    root.reflect.notify(['svc'])
    expect(seen).toContainEqual(['svc', 2])
  })
})

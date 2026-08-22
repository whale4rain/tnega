import { describe, expect, it } from 'vitest'

import { Context, Service, symbols } from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

describe('Service', () => {
  it('provides a class-based service with invoke semantics', () => {
    const root = new Context()
    class CounterService extends Service<never> {
      static provide = 'counter'

      value = 0

      constructor(ctx: Context, start = 0) {
        super(ctx, 'counter')
        this.value = start
      }

      increment() {
        this.value += 1
        return this.value
      }
    }

    const service = new CounterService(root, 10)
    expect((root.get('counter') as CounterService).increment()).toBe(11)
    expect(dynamic(root).counter instanceof CounterService).toBe(true)
    expect(dynamic(root).counter instanceof Service).toBe(true)
    expect((dynamic(root).counter as CounterService).increment()).toBe(12)
    expect(service.value).toBe(12)
  })

  it('creates callable services through symbols.invoke', () => {
    const root = new Context()
    class CallableService extends Service<never> {
      constructor(ctx: Context) {
        super(ctx, 'callable')
      }

      [Service.invoke](name?: string) {
        return `call:${name ?? 'default'}`
      }
    }

    new CallableService(root)
    expect((dynamic(root).callable as (name?: string) => string)('x')).toBe('call:x')
  })

  it('applies check when dependencies are resolved', async () => {
    const root = new Context()
    let healthy = false
    class GatedService extends Service<never> {
      static provide = 'gated'

      constructor(ctx: Context, private checkFn: () => boolean) {
        super(ctx, 'gated')
      }

      [Service.check]() {
        return this.checkFn()
      }
    }

    new GatedService(root, () => healthy)
    const fiber = root.plugin({
      inject: ['gated'],
      apply: () => {},
    })
    await fiber
    expect(fiber.state).toBe(0)

    healthy = true
    root.reflect.notify(['gated'])
    await fiber
    expect(fiber.state).toBe(2)
  })

  it('merges intercept configs into resolveConfig', () => {
    const root = new Context()
    const child = root.intercept('demo', { a: 1 })
    class ConfigService extends Service<Record<string, unknown>> {
      constructor(ctx: Context) {
        super(ctx, 'demo')
      }

      resolve(base?: unknown, head?: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this as any)[symbols.resolveConfig](base, head)
      }
    }

    const service = new ConfigService(child)
    expect(service.resolve({ b: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 })
  })
})

import { describe, expect, it } from 'vitest'

import { Context, FiberState, type Plugin } from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

describe('RegistryService', () => {
  it('mounts and unmounts object plugins', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin({
      name: 'object-plugin',
      apply: () => {
        order.push('mount')
      },
    })

    await fiber
    expect(order).toEqual(['mount'])
    await fiber.dispose()
    expect(root.registry.size).toBe(0)
  })

  it('mounts constructor plugins and provides services', async () => {
    const root = new Context()
    class GreeterPlugin {
      constructor(ctx: Context, config: { greeting: string }) {
        ctx.provide('greeting', config.greeting)
      }
    }

    const fiber = root.plugin(GreeterPlugin, { greeting: 'hi' })
    await fiber
    expect(root.get('greeting')).toBe('hi')
  })

  it('runs plugin disposers and removes listeners on unload', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin((ctx) => {
      order.push('mount')
      ctx.on('hook', () => order.push('listener'))
      return () => order.push('unmount')
    })

    await fiber
    root.emit('hook')
    await fiber.dispose()
    root.emit('hook')

    expect(order).toEqual(['mount', 'listener', 'unmount'])
  })

  it('keeps a dependency pending until its provider loads', async () => {
    const root = new Context()
    const order: string[] = []
    const dep = root.plugin({
      inject: ['model'],
      apply: () => {
        order.push('dep-mount')
        return () => order.push('dep-unmount')
      },
    })
    await dep
    expect(dep.state).toBe(FiberState.PENDING)
    expect(order).toEqual([])

    const provider = root.plugin((ctx) => {
      order.push('provider-mount')
      ctx.provide('model', { name: 'v1' })
    })
    await provider
    await dep

    expect(dep.state).toBe(FiberState.ACTIVE)
    expect(order).toEqual(['provider-mount', 'dep-mount'])
  })

  it('deactivates dependents when the provider unloads', async () => {
    const root = new Context()
    const order: string[] = []
    const dep = root.plugin({
      inject: ['model'],
      apply: () => () => order.push('dep-unmount'),
    })
    const provider = root.plugin((ctx) => {
      ctx.provide('model', { name: 'v1' })
    })
    await provider
    await dep
    expect(dep.state).toBe(FiberState.ACTIVE)

    await provider.dispose()
    expect(dep.state).toBe(FiberState.PENDING)
    expect(order).toEqual(['dep-unmount'])
  })

  it('reactivates a dependent when the provider is replaced', async () => {
    const root = new Context()
    const order: string[] = []
    const dep = root.plugin({
      inject: ['model'],
      apply: () => {
        order.push('dep-mount')
        return () => order.push('dep-unmount')
      },
    })
    const provider = root.plugin((ctx) => {
      ctx.provide('model', { name: 'v1' })
    })
    await provider
    await dep

    await provider.dispose()
    const provider2 = root.plugin((ctx) => {
      ctx.provide('model', { name: 'v2' })
    })
    await provider2
    await dep

    expect(dep.state).toBe(FiberState.ACTIVE)
    expect(order).toEqual(['dep-mount', 'dep-unmount', 'dep-mount'])
  })

  it('keeps one runtime for the same plugin callback and removes it on last unload', async () => {
    const root = new Context()
    const callback = () => {}
    const first = root.plugin(callback)
    const second = root.plugin(callback)
    await Promise.all([first, second])

    expect(root.registry.size).toBe(1)
    expect(root.registry.get(callback)?.fibers.length).toBe(2)

    await first.dispose()
    expect(root.registry.has(callback)).toBe(true)
    await second.dispose()
    expect(root.registry.has(callback)).toBe(false)
    expect(root.registry.size).toBe(0)
  })

  it('supports ctx.inject as a shorthand plugin', async () => {
    const root = new Context()
    const provider = root.plugin((ctx) => {
      ctx.provide('db', { url: 'sqlite://tnega' })
    })
    await provider

    const dep = root.inject(['db'], (ctx) => {
      void (dynamic(ctx).db as { url: string }).url
    })
    await dep
    const url = (dynamic(dep.ctx).db as { url: string })
    expect(url.url).toBe('sqlite://tnega')
  })

  it('keeps circular dependencies pending without side effects', async () => {
    const root = new Context()
    const order: string[] = []
    const a = root.plugin({
      inject: ['b'],
      apply: () => order.push('a'),
    })
    const b = root.plugin({
      inject: ['a'],
      apply: () => order.push('b'),
    })

    await Promise.all([a, b])
    expect(a.state).toBe(FiberState.PENDING)
    expect(b.state).toBe(FiberState.PENDING)
    expect(order).toEqual([])
  })

  it('rejects invalid plugin shapes', () => {
    const root = new Context()
    expect(() => root.plugin({} as unknown as Plugin)).toThrow(/invalid plugin/)
  })
})

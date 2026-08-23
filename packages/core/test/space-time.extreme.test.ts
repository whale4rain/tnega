import { describe, expect, it } from 'vitest'

import { Context, FiberState, type Fiber } from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

async function waitForState(fiber: Fiber, state: FiberState, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (fiber.state !== state) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for fiber state ${state}, current ${fiber.state}`)
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('spacetime composability extreme', () => {
  it('hot swaps a plugin 100 times without leaking listeners, services or disposers', async () => {
    const root = new Context()
    const order: string[] = []

    for (let index = 0; index < 100; index += 1) {
      const fiber = root.plugin((ctx) => {
        ctx.provide('hot.value', index)
        ctx.on('hot.ping', () => order.push(`listener:${index}`))
        ctx.fiber.effect(() => () => order.push(`disposer:${index}`))
      })
      await fiber

      expect(fiber.state).toBe(FiberState.ACTIVE)
      expect(root.get('hot.value')).toBe(index)
      root.emit('hot.ping')
      await fiber.dispose()
    }

    root.emit('hot.ping')

    expect(root.get('hot.value')).toBeUndefined()
    expect(root.registry.size).toBe(0)
    expect(order.filter(entry => entry.startsWith('listener:'))).toHaveLength(100)
    expect(order.filter(entry => entry.startsWith('disposer:'))).toHaveLength(100)
  })

  it('reloads a dependent exactly once for every provider generation', async () => {
    const root = new Context()
    const mounts: string[] = []
    const unmounts: string[] = []

    const dependent = root.plugin({
      inject: ['generation'],
      apply: () => {
        mounts.push('dependent')
        return () => unmounts.push('dependent')
      },
    })
    await dependent
    expect(dependent.state).toBe(FiberState.PENDING)

    let provider: Awaited<ReturnType<Context['plugin']>> | undefined
    for (let generation = 0; generation < 20; generation += 1) {
      if (provider) {
        await provider.dispose()
      }
      provider = await root.plugin((ctx) => {
        ctx.provide('generation', generation)
      })
      await dependent

      expect(dependent.state).toBe(FiberState.ACTIVE)
    }

    await provider!.dispose()

    expect(dependent.state).toBe(FiberState.PENDING)
    expect(mounts).toHaveLength(20)
    expect(unmounts).toHaveLength(20)
  })

  it('cascades activation and deactivation through a 128-plugin dependency chain', async () => {
    const root = new Context()
    const names = Array.from({ length: 128 }, (_, index) => `chain.${index}`)
    const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []

    for (let index = 0; index < names.length; index += 1) {
      const plugin = index === 0
        ? (ctx: Context) => {
          ctx.provide(names[0]!, 0)
        }
        : {
          inject: [names[index - 1]!],
          apply: (ctx: Context) => {
            ctx.provide(names[index]!, index)
          },
        }
      const fiber = root.plugin(plugin)
      await fiber
      expect(fiber.state).toBe(FiberState.ACTIVE)
      fibers.push(await fiber)
    }

    expect(fibers[0]!.state).toBe(FiberState.ACTIVE)
    expect(fibers.at(-1)!.state).toBe(FiberState.ACTIVE)
    expect(root.get(names.at(-1)!)).toBe(names.length - 1)

    await fibers[0]!.dispose()
    await Promise.all(fibers.slice(1).map(fiber => fiber.await()))

    expect(fibers[0]!.state).toBe(FiberState.DISPOSED)
    for (const fiber of fibers.slice(1)) {
      expect(fiber.state).toBe(FiberState.PENDING)
    }
    expect(root.get(names.at(-1)!)).toBeUndefined()

    const replacement = root.plugin((ctx) => {
      ctx.provide(names[0]!, 'new-root')
    })
    await replacement
    await waitForState(fibers.at(-1)!, FiberState.ACTIVE)

    expect(fibers.at(-1)!.state).toBe(FiberState.ACTIVE)
    expect(root.get(names.at(-1)!)).toBe(names.length - 1)
    await replacement.dispose()
    await waitForState(fibers.at(-1)!, FiberState.PENDING)
  })

  it('keeps 64 sibling scopes isolated and only their own key is cleaned', async () => {
    const root = new Context()
    const parent = root.plugin((ctx) => {
      ctx.provide('model', 'parent')
    })
    await parent

    const scopes: Context[] = []
    const locals: Array<Awaited<ReturnType<Context['plugin']>>> = []
    for (let index = 0; index < 64; index += 1) {
      const scope = root.isolate('model')
      const local = scope.plugin((ctx) => {
        ctx.provide('model', `local-${index}`)
      })
      await local

      expect(scope.get('model')).toBe(`local-${index}`)
      expect(root.get('model')).toBe('parent')
      scopes.push(scope)
      locals.push(await local)
    }

    for (const local of locals) {
      await local.dispose()
    }

    for (const scope of scopes) {
      expect(scope.get('model')).toBeUndefined()
      expect(dynamic(scope).model).toBeUndefined()
    }
    expect(root.get('model')).toBe('parent')

    await parent.dispose()
    expect(root.get('model')).toBeUndefined()
    for (const scope of scopes) {
      expect(scope.get('model')).toBeUndefined()
    }
  })

  it('survives a 64-fiber same-plugin mount and unload storm', async () => {
    const root = new Context()
    const calls: number[] = []
    const callback = (ctx: Context) => {
      ctx.on('storm.ping', () => calls.push(1))
    }

    const fibers = Array.from({ length: 64 }, () => root.plugin(callback))
    await Promise.all(fibers)
    expect(fibers.every(fiber => fiber.state === FiberState.ACTIVE)).toBe(true)

    root.emit('storm.ping')
    expect(calls).toHaveLength(64)

    await Promise.all(fibers.map(fiber => fiber.dispose()))
    expect(root.registry.size).toBe(0)

    root.emit('storm.ping')
    expect(calls).toHaveLength(64)
  })

  it('keeps dependents coherent while a health check flickers 64 times', async () => {
    const root = new Context()
    const calls: string[] = []
    let healthy = true
    root.provide('gate', 'ok', () => healthy)

    const dependent = root.plugin({
      inject: ['gate'],
      apply: (ctx) => {
        ctx.on('gate.ping', () => calls.push('active'))
      },
    })
    await dependent
    expect(dependent.state).toBe(FiberState.ACTIVE)

    for (let index = 0; index < 65; index += 1) {
      healthy = !healthy
      root.reflect.notify(['gate'])
      await dependent

      if (healthy) {
        expect(dependent.state).toBe(FiberState.ACTIVE)
      } else {
        expect(dependent.state).toBe(FiberState.PENDING)
      }
    }

    root.emit('gate.ping')
    expect(calls).toHaveLength(0)
    expect(dependent.state).toBe(FiberState.PENDING)
  })

  it('coalesces a 100-update storm into the latest config', async () => {
    const root = new Context()
    const seen: number[] = []
    const fiber = root.plugin((ctx, config: { value: number }) => {
      seen.push(config.value)
      ctx.on('update.ping', () => seen.push(-config.value))
    }, { value: 1 })
    await fiber

    for (let value = 2; value <= 100; value += 1) {
      fiber.update({ value })
    }
    await fiber
    root.emit('update.ping')

    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(seen).toEqual([1, 100, -100])
  })

  it('unloads nested child plugins before a parent unload settles', async () => {
    const root = new Context()
    const order: string[] = []

    const parent = root.plugin(async (ctx) => {
      const child = await ctx.plugin((childCtx) => {
        childCtx.provide('nested.value', 1)
        childCtx.on('nested.ping', () => order.push('child-listener'))
        return () => order.push('child-disposer')
      })
      expect(child.state).toBe(FiberState.ACTIVE)
      return () => order.push('parent-disposer')
    })
    await parent

    expect(root.get('nested.value')).toBe(1)
    root.emit('nested.ping')
    await parent.dispose()
    root.emit('nested.ping')

    expect(root.get('nested.value')).toBeUndefined()
    expect(order).toEqual(['child-listener', 'parent-disposer', 'child-disposer'])
  })

  it('runs remaining disposers when one disposer throws', async () => {
    const root = new Context()
    const order: string[] = []
    const errors: string[] = []
    root.logger.exporter({
      export(message) {
        if (message.type === 'error') {
          errors.push(String(message.args[0]?.message ?? message.args[0]))
        }
      },
    })

    const fiber = root.plugin((ctx) => {
      ctx.fiber.effect(() => () => {
        throw new Error('disposer-boom')
      })
      ctx.fiber.effect(() => () => order.push('clean-after-boom'))
    })
    await fiber
    await fiber.dispose()

    expect(order).toEqual(['clean-after-boom'])
    expect(errors).toContain('disposer-boom')
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(root.registry.size).toBe(0)
  })

  it('keeps sibling scopes immune to a same-name service storm', async () => {
    const root = new Context()
    const left = root.isolate('shared')
    const right = root.isolate('shared')
    const other = root.isolate('other')

    const leftFiber = left.plugin((ctx) => {
      ctx.provide('shared', 'left')
    })
    const rightFiber = right.plugin((ctx) => {
      ctx.provide('shared', 'right')
    })
    const otherFiber = other.plugin((ctx) => {
      ctx.provide('other', 'other')
    })
    await Promise.all([leftFiber, rightFiber, otherFiber])

    expect(left.get('shared')).toBe('left')
    expect(right.get('shared')).toBe('right')
    expect(other.get('other')).toBe('other')
    expect(dynamic(left).shared).toBe('left')
    expect(dynamic(right).shared).toBe('right')

    await (await leftFiber).dispose()
    await (await rightFiber).dispose()

    expect(left.get('shared')).toBeUndefined()
    expect(right.get('shared')).toBeUndefined()
    expect(other.get('other')).toBe('other')
    expect(dynamic(left).shared).toBeUndefined()
    expect(dynamic(right).shared).toBeUndefined()
  })
})

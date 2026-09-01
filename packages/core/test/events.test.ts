import { describe, expect, it, vi } from 'vitest'

import { Context, type DispatchMode } from '../src/index.js'

function makeFiltered(ctx: Context, filter: (target: Context) => boolean): Context {
  const target = Object.create(ctx) as Context
  Object.defineProperty(target, Context.filter, { value: filter })
  return target
}

describe('EventsService', () => {
  it('emits to listeners and removes them with the disposer', () => {
    const root = new Context()
    const calls: string[] = []
    const dispose = root.on('greet', (name: string) => calls.push(name))

    root.emit('greet', 'a')
    dispose()
    root.emit('greet', 'b')

    expect(calls).toEqual(['a'])
  })

  it('binds listeners to an explicit thisArg', () => {
    const root = new Context()
    const calls: string[] = []
    root.on('greet', function (this: { name: string }, value: string) {
      calls.push(`${this.name}:${value}`)
    })

    root.emit({ name: 'app' }, 'greet', 'hi')
    expect(calls).toEqual(['app:hi'])
  })

  it('once only invokes the listener one time', () => {
    const root = new Context()
    const listener = vi.fn()
    root.once('pulse', listener)

    root.emit('pulse')
    root.emit('pulse')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('supports prepend listeners', () => {
    const root = new Context()
    const order: number[] = []
    root.on('order', () => order.push(1))
    root.on('order', () => order.push(2), true)

    root.emit('order')
    expect(order).toEqual([2, 1])
  })

  it('parallel awaits all listeners and aggregates failures', async () => {
    const root = new Context()
    const order: string[] = []
    root.on('job', async (name: string) => {
      await Promise.resolve()
      order.push(name)
    })
    await root.parallel('job', 'done')
    expect(order).toEqual(['done'])

    root.on('job', async () => {
      throw new Error('first')
    })
    root.on('job', async () => {
      throw new Error('second')
    })
    try {
      await root.parallel('job')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors.map(reason => (reason as Error).message)).toEqual(['first', 'second'])
    }
  })

  it('serial stops at the first truthy result', async () => {
    const root = new Context()
    const order: number[] = []
    root.on('check', async () => {
      order.push(1)
      return false
    })
    root.on('check', async () => {
      order.push(2)
      return 'stop'
    })
    root.on('check', async () => {
      order.push(3)
    })

    expect(await root.serial('check')).toBe('stop')
    expect(order).toEqual([1, 2])
  })

  it('bail stops synchronously at the first truthy result', () => {
    const root = new Context()
    const order: number[] = []
    root.on('check', () => {
      order.push(1)
      return false
    })
    root.on('check', () => {
      order.push(2)
      return 'stop'
    })
    root.on('check', () => {
      order.push(3)
    })

    expect(root.bail('check')).toBe('stop')
    expect(order).toEqual([1, 2])
  })

  it('waterfall lets listeners mutate the payload before the final callback', () => {
    const root = new Context()
    root.on('flow', (values: number[], next: () => void) => {
      values[0]! += 1
      return next()
    })
    root.on('flow', (values: number[], next: () => void) => {
      values[0]! *= 2
      return next()
    })

    expect(root.waterfall('flow', [1], (values: number[]) => values[0])).toBe(4)
    expect(root.waterfall('empty', 5, (value: number) => value + 1)).toBe(6)
  })

  it('waterfallAsync awaits async listeners before the final callback', async () => {
    const root = new Context()
    const order: string[] = []
    root.on('flow', async (values: number[], next: () => Promise<number>) => {
      await Promise.resolve()
      values[0]! += 1
      order.push('listener')
      return next()
    })

    const result = await root.waterfallAsync(
      'flow',
      [1],
      (values: number[]) => {
        order.push('final')
        return values[0]! * 2
      },
    )

    expect(result).toBe(4)
    expect(order).toEqual(['listener', 'final'])
  })

  it('removes plugin listeners when the fiber unloads', async () => {
    const root = new Context()
    const calls: string[] = []
    const fiber = root.plugin((ctx) => {
      ctx.on('hook', () => calls.push('plugin'))
    })
    await fiber

    root.emit('hook')
    await fiber.dispose()
    root.emit('hook')

    expect(calls).toEqual(['plugin'])
  })

  it('filters listeners by scope and lets global listeners bypass', async () => {
    const root = new Context()
    const calls: string[] = []
    const fiber = root.plugin((ctx) => {
      ctx.on('hook', () => calls.push('scoped'))
    })
    await fiber
    root.on('hook', () => calls.push('root'))
    root.on('hook', () => calls.push('global'), { global: true })

    const filtered = makeFiltered(root, (target) => target.fiber === fiber.ctx.fiber)
    root.events.emit(filtered, 'hook')

    expect(calls).toEqual(['scoped', 'global'])
  })

  it('dispatches internal/dispatch before regular events', () => {
    const root = new Context()
    const dispatched: Array<[DispatchMode, string, number]> = []
    root.on('internal/dispatch', (mode: DispatchMode, name: string, args: unknown[]) => {
      if (name === 'ping') dispatched.push([mode, name, args.length])
    })

    root.emit('ping', 1)
    expect(dispatched).toEqual([['emit', 'ping', 1]])
  })
})

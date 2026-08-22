import { describe, expect, it } from 'vitest'

import {
  Context,
  CordisError,
  DisposableList,
  FiberState,
  resolveConfig,
  ValidationError,
  type PluginRuntime,
} from '../src/index.js'

describe('Fiber lifecycle', () => {
  it('moves through loading, active, unloading and disposed states', async () => {
    const root = new Context()
    const states: FiberState[] = []
    root.on('internal/status', function (this: import('../src/index.js').Fiber) {
      states.push(this.state)
    })

    const fiber = root.plugin(() => {})
    expect(fiber.state).toBe(FiberState.LOADING)
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)

    await fiber.dispose()
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(states).toEqual([
      FiberState.LOADING,
      FiberState.ACTIVE,
      FiberState.UNLOADING,
      FiberState.DISPOSED,
    ])
  })

  it('stays pending when an injected dependency is missing', async () => {
    const root = new Context()
    let called = false
    const fiber = root.plugin({
      inject: ['missing'],
      apply: () => {
        called = true
      },
    })

    await fiber
    expect(fiber.state).toBe(FiberState.PENDING)
    expect(called).toBe(false)
  })

  it('stays loading while an async generator plugin is running', async () => {
    const root = new Context()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* asyncPlugin(): AsyncGenerator<() => void> {
      await gate
      yield () => {}
    }

    const fiber = root.plugin(asyncPlugin)
    await Promise.resolve()
    expect(fiber.state).toBe(FiberState.LOADING)

    release()
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('rolls back registered effects when loading throws', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin((ctx) => {
      ctx.fiber.effect(() => () => order.push('clean'))
      ctx.on('leak', () => order.push('leak'))
      throw new Error('boom')
    })

    await expect(fiber).rejects.toThrow('boom')
    expect(fiber.state).toBe(FiberState.FAILED)
    expect(order).toEqual(['clean'])

    root.emit('leak')
    expect(order).toEqual(['clean'])
  })

  it('disposes sync effects in reverse registration order', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin((ctx) => {
      ctx.fiber.effect(() => {
        order.push('first')
        return () => order.push('clean-first')
      })
      ctx.fiber.effect(() => {
        order.push('second')
        return () => order.push('clean-second')
      })
    })

    await fiber
    expect(order).toEqual(['first', 'second'])
    await fiber.dispose()
    expect(order).toEqual(['first', 'second', 'clean-second', 'clean-first'])
  })

  it('collects iterable effects and disposes them in reverse', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin((ctx) => {
      ctx.fiber.effect(() => [
        () => order.push('clean-a'),
        () => order.push('clean-b'),
      ])
    })

    await fiber
    await fiber.dispose()
    expect(order).toEqual(['clean-b', 'clean-a'])
  })

  it('awaits async disposers before unloading completes', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin((ctx) => {
      ctx.fiber.effect(() => async () => {
        await Promise.resolve()
        order.push('async-clean')
      })
    })

    await fiber
    await fiber.dispose()
    expect(order).toEqual(['async-clean'])
  })

  it('keeps the fiber loading until a promise effect resolves', async () => {
    const root = new Context()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fiber = root.plugin((ctx) => {
      ctx.fiber.effect(async () => {
        await gate
        return () => order.push('promise-clean')
      })
    })

    await Promise.resolve()
    expect(fiber.state).toBe(FiberState.LOADING)
    release()
    await fiber
    await fiber.dispose()
    expect(order).toEqual(['promise-clean'])
  })

  it('collects async iterator effects', async () => {
    const root = new Context()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fiber = root.plugin((ctx) => {
      ctx.fiber.effect(async function* () {
        await gate
        yield () => order.push('async-iter-clean')
      })
    })

    release()
    await fiber
    await fiber.dispose()
    expect(order).toEqual(['async-iter-clean'])
  })

  it('rejects invalid effect return values', () => {
    const root = new Context()
    expect(() => root.fiber.effect(() => 123 as never)).toThrow(TypeError)
  })

  it('rejects effects created on a disposed context', async () => {
    const root = new Context()
    const fiber = root.plugin(() => {})
    await fiber
    await fiber.dispose()

    expect(() => fiber.ctx.fiber.effect(() => {})).toThrow(CordisError)
    expect(() => fiber.ctx.effect(() => {})).toThrow(CordisError)
  })

  it('reloads on update and removes the old listener', async () => {
    const root = new Context()
    const runs: number[] = []
    const calls: number[] = []
    const fiber = root.plugin((ctx, config: { value: number }) => {
      runs.push(config.value)
      ctx.on('ping', () => calls.push(config.value))
    }, { value: 1 })

    await fiber
    fiber.update({ value: 2 })
    await fiber
    expect(runs).toEqual([1, 2])

    root.emit('ping')
    expect(calls).toEqual([2])
  })

  it('applies the latest config when update races a loading fiber', async () => {
    const root = new Context()
    const values: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* slowPlugin(_ctx: Context, config: { value: number }): AsyncGenerator<() => void> {
      values.push(config.value)
      if (config.value === 1) await gate
      yield () => {}
    }

    const fiber = root.plugin(slowPlugin, { value: 1 })
    await Promise.resolve()
    expect(fiber.state).toBe(FiberState.LOADING)

    fiber.update({ value: 2 })
    release()
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(values).toEqual([2])
  })

  it('returns effect metadata with labels', async () => {
    const root = new Context()
    const fiber = root.plugin((ctx) => {
      ctx.on('labeled', () => {})
    })
    await fiber

    const labels = fiber.ctx.fiber.getEffects().map(effect => effect.label)
    expect(labels).toContain('ctx.on("labeled")')
  })
})

describe('resolveConfig', () => {
  it('passes config through when no Config schema is present', () => {
    const runtime = {} as unknown as PluginRuntime
    expect(resolveConfig(runtime, { raw: 1 })).toEqual({ raw: 1 })
  })

  it('applies a function Config schema', () => {
    const runtime = {
      Config: (config: { raw: number }) => ({ value: config.raw + 1 }),
    } as unknown as PluginRuntime
    expect(resolveConfig(runtime, { raw: 1 })).toEqual({ value: 2 })
  })

  it('validates standard schema configs', () => {
    const runtime = {
      Config: {
        '~standard': {
          version: 1,
          vendor: 'tnega',
          validate: (value: unknown) => ({ value }),
        },
      },
    } as unknown as PluginRuntime
    expect(resolveConfig(runtime, { ok: true })).toEqual({ ok: true })
  })

  it('throws ValidationError for invalid standard schema configs', () => {
    const runtime = {
      Config: {
        '~standard': {
          version: 1,
          vendor: 'tnega',
          validate: () => ({ issues: [{ message: 'invalid config' }] }),
        },
      },
    } as unknown as PluginRuntime
    expect(() => resolveConfig(runtime, {})).toThrow(ValidationError)
  })

  it('rejects async standard schema validation', () => {
    const runtime = {
      Config: {
        '~standard': {
          version: 1,
          vendor: 'tnega',
          validate: async () => ({ value: {} }),
        },
      },
    } as unknown as PluginRuntime
    expect(() => resolveConfig(runtime, {})).toThrow(TypeError)
  })

  it('lets a plugin reject invalid config during mount', async () => {
    const root = new Context()
    const fiber = root.plugin({
      apply: () => {},
      Config: {
        '~standard': {
          version: 1,
          vendor: 'tnega',
          validate: () => ({ issues: [{ message: 'bad' }] }),
        },
      },
    }, {})

    await expect(fiber).rejects.toThrow(ValidationError)
  })

  it('keeps DisposableList available for runtime construction', () => {
    const list = new DisposableList<symbol>()
    expect(list.length).toBe(0)
  })
})

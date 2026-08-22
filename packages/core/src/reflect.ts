import type { Context } from './context.js'
import { FiberState } from './fiber.js'
import { getTraceable, symbols, withProps, type Any, type AnyFunction, type Dict } from './utils.js'

declare module './context.js' {
  interface Context {
    get(name: string, strict?: boolean): Any
    set(name: string, value: Any): void
    provide(name: string, value?: Any, check?: () => boolean): () => Any
    accessor(name: string, options: Omit<AccessorProperty, 'type'>): () => Any
    mixin(source: Any, mixins: string[] | Dict<string>): void
  }
}

function enhanceError(error: Error) {
  const lines = error.stack!.split('\n')
  lines.splice(0, 2, `Error: ${error.message}`)
  error.stack = lines.join('\n')
  return error
}

const RESERVED_WORDS = ['prototype', 'then']

function isSpecialProperty(prop: string | symbol) {
  return typeof prop === 'symbol'
    || RESERVED_WORDS.includes(prop as string)
    || parseInt(prop as string).toString() === prop
    || (prop as string).startsWith('_')
}

export interface ServiceProperty {
  type: 'service'
}

export interface AccessorProperty {
  type: 'accessor'
  get: (this: Context, receiver: Any, error: Error) => Any
  set?: (this: Context, value: Any, receiver: Any, error: Error) => boolean
}

export type ReflectProperty = ServiceProperty | AccessorProperty

export interface Impl {
  name: string
  fiber: Any
  value?: Any
  check?: () => boolean
}

export class ReflectService {
  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.get(target, prop, ctx)
      }
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx))
      }

      const error = new Error(`cannot get property "${String(prop)}" without inject`)
      try {
        const def = target.reflect.props[prop as string]
        if (def?.type === 'accessor') {
          return def.get.call(ctx, ctx[symbols.receiver], error)
        }

        if (!ctx.fiber.runtime) return ctx.reflect.get(prop as string, false)
        return ctx.events.waterfall(ctx, 'internal/get', prop, error, () => {
          const key = target[symbols.isolate]![prop as string]
          let fiber = ((ctx[symbols.shadow] as Context) ?? ctx).fiber
          while (true) {
            const impl = fiber.store?.[prop as string]
            if (impl) return getTraceable(ctx, impl.value)
            if (prop in fiber.inject) {
              error.message = `cannot get required service "${String(prop)}" in inactive context`
              throw error
            }
            if (!fiber.runtime) throw error
            if (fiber.parent[symbols.isolate]![prop as string] !== key) throw error
            fiber = fiber.parent.fiber
          }
        })
      } catch (e: Any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    set: (target, prop, value, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.set(target, prop, value, ctx)
      }

      const error = new Error(`cannot set property "${String(prop)}" without provide`)
      const def = target.reflect.props[prop as string]

      try {
        if (def?.type === 'accessor') {
          if (!def.set) return false
          return def.set.call(ctx, value, ctx[symbols.receiver], error)
        }

        if (!def && !ctx.fiber.runtime) {
          return Reflect.set(target, prop, value, ctx)
        }

        return ctx.events.waterfall(ctx, 'internal/set', prop, value, error, () => {
          if (!def) throw error
          return ctx.reflect.set(prop as string, value)
        })
      } catch (e: Any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    has: (target, prop) => {
      if (isSpecialProperty(prop)) {
        return Reflect.has(target, prop)
      }
      if (Reflect.has(target, prop)) return true
      return !!target.reflect.props[prop as string]
    },
  }

  public store: Dict<Impl, symbol> = Object.create(null)
  public props: Dict<ReflectProperty> = Object.create(null)

  constructor(public ctx: Context) {
    Object.defineProperty(this, symbols.tracker, {
      value: { property: 'ctx', noShadow: true },
    })

    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
    this.mixin('fiber', ['runtime', 'effect'])
    this.mixin('registry', ['inject', 'plugin'])
    this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
  }

  get(name: string, strict = true) {
    return getTraceable(this.ctx, this._getImpl(name, strict)?.value)
  }

  _getImpl(name: string, strict = true) {
    const key = this.ctx[symbols.isolate]![name]
    const impl = key && this.store[key as symbol]
    if (!impl) return
    if (strict && impl.fiber.state !== FiberState.ACTIVE) return
    return impl
  }

  set(name: string, value: Any) {
    const key = this.ctx[symbols.isolate]![name]
    const impl = key && this.store[key as symbol]
    if (!impl) {
      throw new Error(`cannot set property "${name}" without provide`)
    }
    if (impl.fiber !== this.ctx.fiber) {
      throw new Error(`cannot set property "${name}" in multiple fibers`)
    }
    impl.value = value
    return true
  }

  provide(name: string, value?: Any, check?: () => boolean) {
    return this.ctx.fiber.effect(() => {
      if (!this.props[name]) {
        this.props[name] = { type: 'service' }
      } else if (this.props[name].type !== 'service') {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`)
      }
      this.props[name] = { type: 'service' }

      this.ctx.root[symbols.isolate]![name] ??= Symbol(name)
      const key = this.ctx[symbols.isolate]![name]
      const impl: Impl = {
        name,
        value,
        fiber: this.ctx.fiber,
        ...(check ? { check } : {}),
      }
      if (key && this.store[key]) {
        throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`)
      }
      this.store[key as symbol] = impl
      this.ctx.fiber.store![name] = impl
      if (this.ctx.fiber.state === FiberState.ACTIVE) {
        this.notify([name])
      }
      return async () => {
        delete this.store[key as symbol]
        const fibers = this.notify([name])
        await Promise.allSettled(fibers.map(fiber => fiber.await()))
        delete this.ctx.fiber.store![name]
      }
    }, `ctx.provide(${JSON.stringify(name)})`)
  }

  notify(
    names: string[],
    filter = (ctx: Context, name: string) => ctx[symbols.isolate]![name] === this.ctx[symbols.isolate]![name],
  ) {
    const fibers: Any[] = []
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        let hasUpdate = false
        for (const name of names) {
          if (!(name in fiber.inject)) continue
          if (!filter(fiber.ctx, name)) continue
          hasUpdate = true
          fiber._checkImpl(name)
        }
        if (!hasUpdate) continue
        fiber._refresh()
        fibers.push(fiber)
      }
    }
    for (const name of names) {
      const self: Any = Object.create(this.ctx)
      self[symbols.filter] = (target: Context) => filter(target, name)
      this.ctx.events.emit(self, 'internal/service', name, this._getImpl(name, false)?.value)
    }
    return fibers
  }

  accessor(name: string, options: Omit<AccessorProperty, 'type'>) {
    return this.ctx.fiber.effect(() => {
      if (name in this.props) {
        throw new Error(`property "${name}" is already declared as ${this.props[name]!.type}`)
      }
      this.props[name] = { type: 'accessor', ...options }
      return () => delete this.props[name]
    }, `ctx.accessor(${JSON.stringify(name)})`)
  }

  mixin(source: Any, mixins: string[] | Dict<string>) {
    return this.ctx.fiber.effect(() => {
      const entries: [string, string][] = Array.isArray(mixins)
        ? mixins.map(key => [key, key] as [string, string])
        : Object.entries(mixins)
      const getTarget = (target: Context): Any => target[source]
      return entries.map(([key, value]) => {
        return this.accessor(value, {
          get(receiver) {
            const service: Any = getTarget(this)
            if (service == null) return service
            const mixin = receiver ? withProps(receiver, service) : service
            const result = Reflect.get(service, key, mixin)
            if (typeof result !== 'function') return result
            return result.bind(mixin ?? service)
          },
          set(value, receiver) {
            const service: Any = getTarget(this)
            const mixin = receiver ? withProps(receiver, service) : service
            return Reflect.set(service, key, value, mixin)
          },
        })
      })
    }, `ctx.mixin(${JSON.stringify(source)})`)
  }

  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  bind<T extends AnyFunction>(callback: T) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return Reflect.apply(target, this.trace(thisArg), args.map(arg => this.trace(arg)))
      },
      construct: (target, args, newTarget) => {
        return Reflect.construct(target, args.map(arg => this.trace(arg)), newTarget)
      },
    })
  }
}

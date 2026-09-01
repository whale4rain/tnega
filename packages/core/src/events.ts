import { Context } from './context.js'
import { DisposableList, symbols, type Any, type AnyFunction } from './utils.js'

declare module './context.js' {
  interface Context {
    on(name: string, listener: AnyFunction, options?: boolean | EventOptions): () => Any
    once(name: string, listener: AnyFunction, options?: boolean | EventOptions): () => Any
    emit(name: string, ...args: Any[]): void
    emit(thisArg: object, name: string, ...args: Any[]): void
    parallel(name: string, ...args: Any[]): Promise<void>
    parallel(thisArg: object, name: string, ...args: Any[]): Promise<void>
    serial(name: string, ...args: Any[]): Promise<void>
    serial(thisArg: object, name: string, ...args: Any[]): Promise<void>
    bail(name: string, ...args: Any[]): Any
    bail(thisArg: object, name: string, ...args: Any[]): Any
    waterfall(name: string, ...args: Any[]): Any
    waterfall(thisArg: object, name: string, ...args: Any[]): Any
    waterfallAsync(name: string, ...args: Any[]): Promise<Any>
    waterfallAsync(thisArg: object, name: string, ...args: Any[]): Promise<Any>
  }
}

export function isBailed(value: Any) {
  return value !== null && value !== false && value !== undefined
}

export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall' | 'waterfallAsync'

export interface EventOptions {
  prepend?: boolean
  global?: boolean
}

export interface Hook extends EventOptions {
  ctx: Context
  callback: AnyFunction
}

export class EventsService {
  _hooks: Record<string, Hook[]> = Object.create(null)

  constructor(private ctx: Context) {
    Object.defineProperty(this, symbols.tracker, {
      value: { property: 'ctx', noShadow: true },
    })

    this.on('internal/listener', function (this: Context, name: string, listener: AnyFunction, options: EventOptions) {
      if (name === 'internal/update' && !options.global) {
        const hooks = (this.fiber._hooks['internal/update'] ??= new DisposableList<AnyFunction>())
        const method = options.prepend ? 'unshift' : 'push'
        return hooks[method](listener)
      }
    })

    this.on('internal/update', function (this: Context, config: Any, noSave: boolean, next: AnyFunction) {
      const cbs = [...(this.fiber._hooks['internal/update'] ?? [])]
      const _next = () => {
        const cb = cbs.shift() ?? next
        return cb.call(this, config, noSave, _next)
      }
      return _next()
    }, { global: true, prepend: true })
  }

  private _resolve(type: string, args: Any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name: string = args.shift()
    if (!name.startsWith('internal/') && this._hooks['internal/dispatch']?.length) {
      this.emit('internal/dispatch', type, name, args, thisArg)
    }
    const filter = thisArg?.[Context.filter]
    return [thisArg, (this._hooks[name] || [])
      .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
      .map(hook => hook.callback)] as const
  }

  dispatch(type: string, args: Any[]) {
    const [thisArg, callbacks] = this._resolve(type, args)
    return callbacks.map(callback => callback.bind(thisArg))
  }

  async parallel(...args: Any[]) {
    const [thisArg, callbacks] = this._resolve('parallel', args)
    const results = await Promise.allSettled(callbacks.map(async callback => Reflect.apply(callback, thisArg, args)))
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (errors.length) throw new AggregateError(errors)
  }

  emit(...args: Any[]) {
    const [thisArg, callbacks] = this._resolve('emit', args)
    for (const callback of callbacks) Reflect.apply(callback, thisArg, args)
  }

  async serial(...args: Any[]) {
    const [thisArg, callbacks] = this._resolve('serial', args)
    for (const callback of callbacks) {
      const result = await Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  bail(...args: Any[]) {
    const [thisArg, callbacks] = this._resolve('bail', args)
    for (const callback of callbacks) {
      const result = Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  waterfall(...args: Any[]) {
    const [thisArg, callbacks] = this._resolve('waterfall', args)
    const inner = args.pop()
    const next = () => {
      const callback = callbacks.shift()
      return callback ? Reflect.apply(callback, thisArg, args) : inner(...args)
    }
    args.push(next)
    return next()
  }

  async waterfallAsync(...args: Any[]) {
    const [thisArg, callbacks] = this._resolve('waterfallAsync', args)
    const inner = args.pop()
    const next = async () => {
      const callback = callbacks.shift()
      return callback
        ? await Reflect.apply(callback, thisArg, args)
        : inner(...args)
    }
    args.push(next)
    return next()
  }

  register(label: string, hooks: Hook[], callback: AnyFunction, options: EventOptions): Any {
    const method = options.prepend ? 'unshift' : 'push'
    return this.ctx.fiber.effect(() => {
      hooks[method]({ ctx: this.ctx, callback, ...options })
      return () => this.unregister(hooks, callback)
    }, label)
  }

  unregister(hooks: Hook[], callback: AnyFunction) {
    const index = hooks.findIndex(hook => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      return true
    }
  }

  on(name: string, listener: AnyFunction, options: boolean | EventOptions = {}): Any {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }
    this.ctx.fiber.assertActive()
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    const hooks = this._hooks[name] ??= []
    return this.register(`ctx.on(${JSON.stringify(name)})`, hooks, listener, options)
  }

  once(name: string, listener: AnyFunction, options: boolean | EventOptions = {}) {
    const dispose = this.on(name, function (this: Any, ...args: Any[]) {
      dispose()
      return listener.apply(this, args)
    }, options)
    return dispose
  }
}

export interface Events {
  'internal/plugin'(this: Any): void
  'internal/status'(this: Any, oldValue: Any): void
  'internal/service'(this: Context, name: string, value: Any): void
  'internal/update'(this: Any, config: Any, noSave: boolean, next: AnyFunction): void
  'internal/get'(this: Context, name: string, error: Error, next: AnyFunction): Any
  'internal/set'(this: Context, name: string, value: Any, error: Error, next: AnyFunction): boolean
  'internal/listener'(this: Context, name: string, listener: AnyFunction, options: EventOptions): Any
  'internal/dispatch'(mode: DispatchMode, name: string, args: Any[], thisArg: Any): void
}

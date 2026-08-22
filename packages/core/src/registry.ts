import type { Context } from './context.js'
import { Fiber } from './fiber.js'
import { buildOuterStack, DisposableList, symbols, withProps, type Any, type AnyFunction, type Dict } from './utils.js'

declare module './context.js' {
  interface Context {
    inject(deps: Inject, callback: FunctionPlugin): Fiber & PromiseLike<Fiber>
    plugin<P extends Plugin>(plugin: P, ...args: Any[]): Fiber & PromiseLike<Fiber>
  }
}

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Inject = string[] | Dict<Any>
export type InjectKey = string & keyof Context

export function Inject(name: string, config?: Any) {
  return function (value: Any, decorator: Any) {
    if (decorator.kind === 'class') {
      if (!Object.hasOwn(value, 'inject')) {
        Object.defineProperty(value, 'inject', {
          value: Object.create(Object.getPrototypeOf(value).inject ?? null),
        })
        Object.defineProperty(value.inject, symbols.checkProto, { value: true })
      }
      value.inject[name] = config
    } else if (decorator.kind === 'method') {
      const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null)
      inject[name] = config
      decorator.addInitializer(function (this: Any) {
        const property = this[symbols.tracker]?.property
        ;(this[symbols.initHooks] ??= []).push(() => {
          (this.ctx as Context).inject(inject, (ctx) => {
            return value.call(property ? withProps(this, { [property]: ctx }) : this)
          })
        })
      })
    } else {
      throw new Error('@Inject() can only be used on class or class methods')
    }
  }
}

export function resolveInject(inject: Inject | null | undefined, result: Dict = Object.create(null)) {
  if (!inject) return result
  if (Array.isArray(inject)) {
    for (const name of inject) {
      result[name] = null
    }
  } else if (Reflect.has(inject, symbols.checkProto)) {
    Object.assign(result, resolveInject(Object.getPrototypeOf(inject)))
    for (const name of Object.keys(inject)) {
      result[name] = inject[name] ?? null
    }
  } else {
    for (const name of Object.keys(inject)) {
      result[name] = inject[name] ?? null
    }
  }
  return result
}

export type Plugin = FunctionPlugin | ConstructorPlugin | ObjectPlugin

export interface PluginBase {
  name?: string
  Config?: Any
  inject?: Inject
  provide?: string | string[]
  intercept?: Dict<boolean>
}

export interface FunctionPlugin extends PluginBase {
  (ctx: Context, config: Any): Any
}

export interface ConstructorPlugin extends PluginBase {
  new (ctx: Context, config: Any): Any
}

export interface ObjectPlugin extends PluginBase {
  apply(ctx: Context, config: Any): Any
}

export interface PluginRuntime {
  name?: string
  fibers: DisposableList<Fiber>
  callback: Any
  Config?: Any
}

export class RegistryService {
  private _counter = 0
  private _internal = new Map<AnyFunction, PluginRuntime>()

  constructor(public ctx: Context) {
    Object.defineProperty(this, symbols.tracker, {
      value: { property: 'ctx', noShadow: true },
    })
  }

  get counter() {
    return ++this._counter
  }

  get size() {
    return this._internal.size
  }

  resolve(plugin: Plugin): AnyFunction | undefined {
    try {
      if (typeof plugin === 'function') return plugin as AnyFunction
      if (isApplicable(plugin)) return plugin.apply
    } catch {
      // getters on plugin objects may throw during resolution
    }
  }

  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    for (const fiber of [...runtime.fibers]) {
      fiber.dispose()
    }
    return runtime
  }

  keys() {
    return this._internal.keys()
  }

  values() {
    return this._internal.values()
  }

  entries() {
    return this._internal.entries()
  }

  forEach(callback: (value: PluginRuntime, key: AnyFunction) => void) {
    return this._internal.forEach(callback)
  }

  inject(inject: Inject, callback: FunctionPlugin) {
    const name = callback.name || undefined
    return this.plugin(Object.assign(
      { inject, apply: callback },
      name ? { name } : {},
    ))
  }

  plugin(plugin: Plugin, config?: Any, getOuterStack = buildOuterStack()) {
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    this.ctx.fiber.assertActive()

    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      if (name === 'apply') name = undefined
      runtime = {
        callback,
        fibers: new DisposableList(),
        ...(name ? { name } : {}),
        ...(plugin.Config ? { Config: plugin.Config } : {}),
      }
      this._internal.set(callback, runtime)
    }

    const fiber = new Fiber(this.ctx, config, resolveInject(plugin.inject), runtime, getOuterStack)
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    wrapped.then = (onFulfilled: Any, onRejected: Any) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
}

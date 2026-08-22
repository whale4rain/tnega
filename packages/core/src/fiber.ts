import type { Context } from './context.js'
import type { PluginRuntime } from './registry.js'
import type { Impl } from './reflect.js'
import {
  buildOuterStack,
  composeError,
  DisposableList,
  getTraceable,
  isConstructor,
  isNullable,
  isObject,
  symbols,
  type Any,
  type AnyFunction,
  type Dict,
} from './utils.js'

declare module './context.js' {
  interface Context extends Pick<Fiber, 'effect'> {
    fiber: Fiber
  }
}

const INACTIVE = '__INACTIVE__'

export class ValidationError extends TypeError {
  override name = 'ValidationError'

  constructor(issues: readonly Any[]) {
    super('invalid config:\n' + issues.map(issue => {
      if (issue.path) {
        return `  - ${issue.message} (at ${issue.path.join('.')})`
      }
      return `  - ${issue.message}`
    }).join('\n'))
  }
}

export function resolveConfig(runtime: PluginRuntime, config: Any) {
  if (!runtime.Config) return config
  const schema = runtime.Config
  if (typeof schema === 'function') return schema(config)
  const validate = schema?.['~standard']?.validate
  if (typeof validate === 'function') {
    const result = validate(config)
    if ('then' in result) {
      throw new TypeError('Async config validation is not supported')
    }
    if (result.issues) {
      throw new ValidationError(result.issues)
    }
    return result.value
  }
  return config
}

export type Disposable = () => Any
export type SyncEffect = Disposable | Iterable<Disposable> | null | undefined
export type AsyncEffect = Promise<Disposable> | AsyncIterable<Disposable> | null | undefined
export type Effect = SyncEffect | AsyncEffect

interface AsyncDisposable extends PromiseLike<() => Promise<void>> {
  (): Any
}

export interface EffectMeta {
  label: string
  children: EffectMeta[]
}

interface EffectRunner<T> {
  epoch: T
  execute: () => Any
  collect: (dispose: Disposable) => void
  getOuterStack: () => string[]
}

export const enum FiberState {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
  UNLOADING,
}

export const CordisErrorCode = {
  INACTIVE_EFFECT: 'cannot create effect on inactive context',
} as const

export type CordisErrorCode = keyof typeof CordisErrorCode

export class CordisError extends Error {
  constructor(public code: CordisErrorCode, message?: string) {
    super(message ?? CordisErrorCode[code])
  }
}

export class Fiber {
  public uid: number | null
  public readonly ctx: Context
  public config: Any
  public state = FiberState.PENDING
  public readonly dispose: () => Promise<void>
  public store: Dict<Impl> | undefined
  public inertia: Promise<void> | undefined

  public readonly _hooks: Dict<DisposableList<AnyFunction>> = Object.create(null)
  public readonly _disposables = new DisposableList<Disposable>()

  protected context: Context

  private _error: Any = undefined
  private _runner: EffectRunner<string>
  private _store: Dict<Impl> = Object.create(null)
  private _restarting: Promise<void> | undefined

  constructor(
    public parent: Context,
    config: Any,
    public inject: Dict<Any>,
    public runtime: PluginRuntime | null,
    getOuterStack: () => string[],
  ) {
    const collect = (dispose: Disposable) => {
      this._disposables.push(dispose)
    }

    if (runtime) {
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ fiber: this })

      const injectEntries = Object.entries(this.inject)
      if (injectEntries.length) {
        this.ctx[symbols.intercept] = Object.create(parent[symbols.intercept]!)
        for (const [name, config] of injectEntries) {
          if (isNullable(config)) continue
          this.ctx[symbols.intercept]![name] = config
        }
      }

      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: () => {
          if (isConstructor(runtime.callback)) {
            const instance = new runtime.callback(this.ctx, this.config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return runtime.callback(this.ctx, this.config)
          }
        },
        collect,
      }

      this.context.emit(this, 'internal/plugin')

      for (const name of Object.keys(this.inject)) {
        this._checkImpl(name)
      }

      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this)
        try {
          this.config = resolveConfig(runtime, config)
          this._refresh()
        } catch (error) {
          this.ctx.logger.error(error)
          this._error = error
        }
        return async () => {
          this.uid = null
          this.context.emit(this, 'internal/plugin')
          if (this.ctx.registry.has(runtime.callback)) {
            remove()
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback)
            }
          }
          this._setEpoch(INACTIVE)
          while (this.inertia) {
            await this.inertia
          }
        }
      }, 'ctx.plugin()')
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this.store = Object.create(null)
      this._runner = {
        epoch: '',
        getOuterStack,
        execute: () => {},
        collect,
      }
      this.dispose = () => this.restart()
    }
  }

  get name() {
    if (this.runtime?.name) return this.runtime.name
    let fiber = this.parent.fiber
    while (fiber !== fiber.parent.fiber) {
      if (fiber.runtime?.name) return fiber.runtime.name
      fiber = fiber.parent.fiber
    }
    return 'root'
  }

  assertActive() {
    if (this.uid !== null) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  private _execute<T>(runner: EffectRunner<T>) {
    const oldEpoch = runner.epoch
    return composeError((info: Any) => {
      const safeCollect = (dispose: Any) => {
        if (typeof dispose === 'function') {
          runner.collect(dispose)
        } else if (!isNullable(dispose)) {
          throw new TypeError('Invalid effect')
        }
      }
      const effect: Effect = runner.execute.call(this)
      if (typeof effect === 'function') {
        return runner.collect(effect)
      } else if (isNullable(effect)) {
        return
      } else if (!isObject(effect)) {
        throw new TypeError('Invalid effect')
      } else if ('then' in effect) {
        return (effect as Any).then(safeCollect)
      } else if (Symbol.iterator in effect) {
        info.error = new Error()
        const iter = (effect as Any)[Symbol.iterator]()
        while (true) {
          const result = iter.next()
          safeCollect(result.value)
          if (result.done) return
        }
      } else if (Symbol.asyncIterator in effect) {
        const iter = (effect as Any)[Symbol.asyncIterator]()
        return (async () => {
          await Promise.resolve()
          info.error = new Error()
          while (true) {
            if (runner.epoch !== oldEpoch) return
            const result = await iter.next()
            safeCollect(result.value)
            if (result.done) return
          }
        })()
      } else {
        throw new TypeError('Invalid effect')
      }
    }, runner.getOuterStack)
  }

  effect(execute: () => SyncEffect, label?: string): Disposable
  effect(execute: () => Effect, label?: string): AsyncDisposable
  effect(execute: () => Effect, label = 'anonymous'): Any {
    this.assertActive()

    const disposables: Disposable[] = []
    const dispose = () => {
      let task: Any
      for (const dispose of disposables.splice(0).reverse()) {
        if (task) {
          task = task.then(dispose)
        } else {
          const result = dispose()
          if (isObject(result) && 'then' in result) {
            task = result
          }
        }
      }
      return task
    }

    const meta: EffectMeta = { label, children: [] }
    const runner: EffectRunner<boolean> = {
      execute,
      epoch: true,
      collect: (dispose) => {
        disposables.push(dispose)
        this._disposables.delete(dispose)
        if ((dispose as Any)[symbols.effect]) {
          meta.children.push((dispose as Any)[symbols.effect])
        }
      },
      getOuterStack: buildOuterStack(),
    }

    let task: Any
    try {
      task = this._execute(runner)
    } catch (reason) {
      dispose()
      throw reason
    }

    task?.catch(dispose).catch((error: Any) => this.ctx.logger.error(error))

    const wrapper = Object.defineProperty(() => {
      if (!runner.epoch) return
      runner.epoch = false
      return task ? task.then(dispose) : dispose()
    }, symbols.effect, { value: meta }) as AsyncDisposable

    const disposeAsync = () => {
      if (!runner.epoch) return
      runner.epoch = false
      return dispose()
    }
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task)
        .then(() => disposeAsync)
        .then(onFulfilled, onRejected)
    }
    disposables.push(this._disposables.push(wrapper))
    return wrapper
  }

  getEffects() {
    return [...this._disposables]
      .map<EffectMeta>(dispose => (dispose as Any)[symbols.effect])
      .filter(Boolean)
  }

  private _getState() {
    if (this.uid === null) return FiberState.DISPOSED
    if (this._error) return FiberState.FAILED
    if (this._runner.epoch !== INACTIVE) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  private _updateState(callback?: () => void | FiberState) {
    const oldState = this.state
    this.state = callback?.() ?? this._getState()
    if (oldState === this.state) return
    this.context.emit(this, 'internal/status', oldState)

    if (oldState !== FiberState.ACTIVE && this.state !== FiberState.ACTIVE) return
    for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
      const impl = this.ctx.reflect.store[key as symbol]
      if (!impl) continue
      if (impl.fiber !== this) continue
      this.ctx.reflect.notify([impl.name])
    }
  }

  _checkImpl(name: string) {
    const impl = this.ctx.reflect._getImpl(name, true)
    if (!impl) return delete this._store[name]
    try {
      if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) {
        return delete this._store[name]
      }
    } catch (error) {
      impl.fiber.ctx.logger.error(error)
      return delete this._store[name]
    }
    this._store[name] = impl
  }

  _refresh() {
    let epoch: string = ''
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + impl.fiber.uid
    }
    this._setEpoch(epoch)
  }

  private _setEpoch(epoch: string) {
    const oldEpoch = this._runner.epoch
    if (epoch === oldEpoch) return
    this._runner.epoch = epoch
    if (this.inertia) return
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  private async _reload() {
    this.store = { ...this._store }
    const oldEpoch = this._runner.epoch
    try {
      await Promise.resolve()
      await this._execute(this._runner)
    } catch (reason) {
      this.ctx.logger.error(reason)
      this._error = reason
      this._runner.epoch = INACTIVE
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) {
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  private async _unload() {
    await Promise.all(this._disposables.clear().map(async (dispose: Disposable) => {
      try {
        await composeError(async (info: Any) => {
          await Promise.resolve()
          info.error = new Error()
          await dispose()
        }, this._runner.getOuterStack)
      } catch (reason) {
        this.ctx.logger.error(reason)
      }
    }))
    this.store = undefined
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) {
        this.inertia = undefined
      } else {
        this.inertia = this._reload()
        return FiberState.LOADING
      }
    })
  }

  async await() {
    while (this.inertia || this._restarting) {
      await Promise.all([this.inertia, this._restarting]
        .filter((task): task is Promise<void> => !!task))
    }
    if (this._error) throw this._error
    return this
  }

  async restart() {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    if (fiber._restarting) return fiber._restarting.then(() => undefined)
    let resolve!: () => void
    const restarting = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise
    })
    fiber._restarting = restarting
    try {
      await this._runRestart(fiber)
    } finally {
      fiber._restarting = undefined
      resolve()
    }
  }

  private async _runRestart(fiber: Fiber) {
    if (fiber.inertia) {
      fiber._setEpoch(INACTIVE)
      while (fiber.inertia) await fiber.inertia
    }
    fiber._setEpoch(INACTIVE)
    fiber._refresh()
    while (fiber.inertia) await fiber.inertia
  }

  update(config: Any, noSave = false) {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    config = resolveConfig(fiber.runtime!, config)
    fiber.context.waterfall(fiber.context, 'internal/update', config, noSave, () => {
      fiber.config = config
      fiber._error = undefined
      return fiber.restart()
    })
  }
}

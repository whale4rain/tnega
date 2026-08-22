/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { EventsService } from './events.js'
import { Fiber } from './fiber.js'
import { Logger, LoggerService } from './logger.js'
import { ReflectService } from './reflect.js'
import { RegistryService } from './registry.js'
import { getTraceable, symbols, type Any, type Dict } from './utils.js'

export interface Context {
  [symbols.isolate]: Dict<symbol | undefined>
  [symbols.intercept]: Dict<Any>
  root: this
  baseUrl?: string | undefined
  events: EventsService
  logger: LoggerService & ((name?: string) => Logger)
  reflect: ReflectService
  registry: RegistryService
}

export class Context {
  static readonly effect: symbol = symbols.effect
  static readonly filter: symbol = symbols.filter
  static readonly isolate: symbol = symbols.isolate
  static readonly intercept: symbol = symbols.intercept
  static readonly marker = Symbol.for('tnega.is')

  static is(value: Any): value is Context {
    return !!value?.[Context.marker]
  }

  static {
    (Context.prototype as Any)[Context.marker] = true
  }

  constructor() {
    this[symbols.isolate] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    const self = new Proxy<this>(this, ReflectService.handler)
    this.root = self
    this.baseUrl = undefined
    this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
    this.reflect = new ReflectService(self)
    this.registry = new RegistryService(self)
    this.events = new EventsService(self)
    this.logger = new LoggerService(self)
    this.fiber._disposables.clear()
    return self
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.fiber.name}>`
  }

  extend(meta: Dict = {}): this {
    const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
    const self = Object.create(getTraceable(this, this))
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
    }
    if (!shadow) return self
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
  }

  isolate(name: string, label?: symbol) {
    const shadow = Object.create(this[symbols.isolate]!)
    shadow[name] = label ?? Symbol(name)
    return this.extend({ [symbols.isolate]: shadow })
  }

  intercept(name: string, config: Any) {
    const intercept = Object.create(this[symbols.intercept]!)
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
  }
}

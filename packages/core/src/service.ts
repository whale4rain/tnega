import type { Context } from './context.js'
import { createCallable, joinPrototype, symbols, type Any, type Tracker } from './utils.js'

export abstract class Service<out T = never> {
  static readonly init: symbol = symbols.init
  static readonly check: symbol = symbols.check
  static readonly config: symbol = symbols.config
  static readonly invoke: symbol = symbols.invoke
  static readonly extend: symbol = symbols.extend
  static readonly tracker: symbol = symbols.tracker
  static readonly resolveConfig: symbol = symbols.resolveConfig

  declare [symbols.config]: T

  public name!: string

  constructor(protected ctx: Context, name?: string) {
    name ??= (this.constructor as Any).provide as string

    const tracker: Tracker = {
      associate: name,
      property: 'ctx',
    }
    const self: Any = (this as Any)[symbols.invoke]
      ? createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker)
      : this

    self.ctx = ctx
    self.name = name
    Object.defineProperty(self, symbols.tracker, { value: tracker })

    self.ctx.reflect.provide(name, self, (this as Any)[symbols.check])
    return self
  }

  protected [symbols.filter](ctx: Context) {
    return ctx[symbols.isolate]![this.name] === this.ctx[symbols.isolate]![this.name]
  }

  protected [symbols.extend](props?: Any) {
    let self: Any
    if ((this as Any)[Service.invoke]) {
      self = createCallable(this.name, this, (this as Any)[symbols.tracker])
    } else {
      self = Object.create(this)
    }
    return Object.assign(self, props)
  }

  [symbols.resolveConfig](base?: T, head?: T): T {
    let intercept: Any = this.ctx[symbols.intercept]!
    const configs: Any[] = []
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) {
        configs.unshift(intercept[this.name])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    if (base) configs.unshift(base)
    if (head) configs.push(head)
    if ((this as Any)['Config']?.merge) {
      return (this as Any)['Config'].merge(...configs)
    } else {
      return Object.assign({}, ...configs)
    }
  }

  static [Symbol.hasInstance](instance: Any) {
    if (!instance) return false
    let constructor = instance.constructor
    while (constructor) {
      constructor = constructor.prototype?.constructor
      if (constructor === this) return true
      constructor &&= Object.getPrototypeOf(constructor)
    }
    return false
  }
}

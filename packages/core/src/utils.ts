/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type Any = any
export type AnyFunction = (...args: Any[]) => Any
export type Dict<T = Any, K extends PropertyKey = string> = Record<K, T>

export class DisposableList<T extends WeakKey> {
  private sn = 0
  private map = new Map<number, T>()
  private weak = new WeakMap<T, number>()

  get length() {
    return this.map.size
  }

  push(value: T) {
    const sn = ++this.sn
    this.map.set(sn, value)
    this.weak.set(value, sn)
    return () => this.map.delete(sn)
  }

  unshift(value: T) {
    const sn = ++this.sn
    const entries = [...this.map.entries()]
    this.map.clear()
    this.map.set(sn, value)
    this.weak.set(value, sn)
    for (const [oldSn, oldValue] of entries) {
      this.map.set(oldSn, oldValue)
    }
    return () => this.map.delete(sn)
  }

  delete(value: T) {
    const sn = this.weak.get(value)
    if (!sn) return false
    return this.map.delete(sn)
  }

  clear() {
    const values = [...this.map.values()]
    this.map.clear()
    return values.reverse()
  }

  [Symbol.iterator]() {
    return this.map.values()
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return [...this]
  }
}

export interface Tracker {
  associate?: string
  property?: string
  noShadow?: boolean
}

export const symbols = {
  shadow: Symbol.for('tnega.shadow'),
  caller: Symbol.for('tnega.caller'),
  receiver: Symbol.for('tnega.receiver'),
  original: Symbol.for('tnega.original'),
  metadata: Symbol.for('tnega.metadata'),
  initHooks: Symbol.for('tnega.initHooks'),
  checkProto: Symbol.for('tnega.checkProto'),
  effect: Symbol.for('tnega.effect'),
  filter: Symbol.for('tnega.filter'),
  isolate: Symbol.for('tnega.isolate'),
  intercept: Symbol.for('tnega.intercept'),
  init: Symbol.for('tnega.init'),
  check: Symbol.for('tnega.check'),
  config: Symbol.for('tnega.config'),
  invoke: Symbol.for('tnega.invoke'),
  extend: Symbol.for('tnega.extend'),
  tracker: Symbol.for('tnega.tracker'),
  resolveConfig: Symbol.for('tnega.resolveConfig'),
} as const

const GeneratorFunction = function* () {}.constructor
const AsyncGeneratorFunction = async function* () {}.constructor

export function isConstructor(func: Any): func is new (...args: Any[]) => Any {
  if (typeof func !== 'function') return false
  if (func instanceof GeneratorFunction) return false
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false
  return /^class\s/.test(Function.prototype.toString.call(func))
}

export function isObject(value: Any): value is object {
  return !!value && (typeof value === 'object' || typeof value === 'function')
}

export function isNullable(value: Any) {
  return value == null
}

export function joinPrototype(proto1: object, proto2: object): object {
  if (proto1 === Object.prototype) return proto2
  const result: object = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2))
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Reflect.getOwnPropertyDescriptor(proto1, key)!)
  }
  return result
}

export function getPropertyDescriptor(target: Any, prop: string | symbol) {
  let proto = target
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop)
    if (desc) return desc
    proto = Object.getPrototypeOf(proto)
  }
}

export function getTraceable<T>(ctx: Any, value: T): T {
  if (!isObject(value)) return value
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  const tracker = (value as Any)[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker)
}

export function withProps(target: Any, props?: Any) {
  if (!props) return target
  return new Proxy(target, {
    get: (target, prop, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.get(props, prop, receiver)
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.set(props, prop, value, receiver)
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

function withProp(target: Any, prop: string | symbol, value: Any) {
  return withProps(target, Object.defineProperty(Object.create(null), prop, {
    value,
    writable: false,
  }))
}

function createShadow(ctx: Any, target: Any, property: string | undefined, receiver: Any) {
  if (!property) return receiver
  const origin = getPropertyDescriptor(target, property)?.value
  if (!origin) return receiver
  return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }))
}

function createShadowMethod(ctx: Any, value: Any, outer: Any, shadow: Any) {
  const proxy = new Proxy(value, {
    apply: (target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
  return proxy
}

function createTraceable(ctx: Any, value: Any, tracker: Tracker) {
  const caller = ctx[symbols.shadow] ?? ctx
  if (ctx[symbols.shadow]) {
    ctx = Object.getPrototypeOf(ctx)
  }
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      if (prop === symbols.original) return target
      if (prop === symbols.caller) return caller
      if (prop === tracker.property) return ctx
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver))
      }
      let shadow: Any
      let innerValue: Any
      const desc = getPropertyDescriptor(target, prop)
      if (desc?.value !== undefined) {
        innerValue = desc.value
      } else {
        shadow = createShadow(ctx, target, tracker.property, receiver)
        innerValue = Reflect.get(target, prop, shadow)
      }
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        return createTraceable(ctx, innerValue, innerTracker)
      } else if (!tracker.noShadow && typeof innerValue === 'function') {
        shadow ??= createShadow(ctx, target, tracker.property, receiver)
        return createShadowMethod(ctx, innerValue, receiver, shadow)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      if (prop === symbols.original || prop === symbols.caller || prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver))
      }
      const shadow = createShadow(ctx, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)
    },
    apply: (target, thisArg, args) => {
      const receiver = tracker.noShadow
        ? proxy
        : createShadow(ctx, target, tracker.property, proxy)
      return applyTraceable(receiver, target, thisArg, args)
    },
  })
  return proxy
}

function applyTraceable(proxy: Any, value: Any, thisArg: Any, args: Any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

export function createCallable(name: string, proto: object, tracker: Tracker) {
  const self: Any = function (this: Any, ...args: Any[]) {
    const proxy = createTraceable(self.ctx, self, tracker)
    return Reflect.apply(proxy, this, args)
  }
  Object.defineProperty(self, 'name', { value: name, configurable: true, writable: true })
  return Object.setPrototypeOf(self, proto)
}

interface StackInfo {
  offset: number
  error: Error
}

function handleError(info: StackInfo, reason: Any, getOuterStack: () => string[]): never {
  const innerLines = info.error.stack!.split('\n')
  if (typeof reason?.stack !== 'string') {
    const outerError = new Error(reason)
    const lines = outerError.stack!.split('\n')
    lines.splice(1, Infinity, ...getOuterStack())
    outerError.stack = lines.join('\n')
    throw outerError
  }
  const lines: string[] = reason.stack.split('\n')
  const index = lines.indexOf(innerLines[2]!)
  if (index === -1) throw reason
  lines.splice(index - info.offset, Infinity, ...getOuterStack())
  reason.stack = lines.join('\n')
  throw reason
}

export function composeError<T>(callback: (info: StackInfo) => T, getOuterStack = buildOuterStack()): T {
  const info: StackInfo = { offset: 1, error: new Error() }
  try {
    const result: Any = callback(info)
    if (isObject(result) && 'then' in result) {
      return (result as Any).then(undefined, (reason: Any) => handleError(info, reason, getOuterStack)) as T
    }
    return result
  } catch (reason: Any) {
    handleError(info, reason, getOuterStack)
  }
}

export function buildOuterStack(offset = 0) {
  const outerError = new Error()
  return () => outerError.stack!.split('\n').slice(3 + offset)
}

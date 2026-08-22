/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import type { Context } from './context.js'
import { createCallable, joinPrototype, symbols, type Any } from './utils.js'

export type LoggerType = 'error' | 'info' | 'warn' | 'debug'
export type LoggerMethod = (format: Any, ...param: Any[]) => void

export interface Message {
  sn: number
  ts: number
  name: string
  type: LoggerType
  args: Any[]
}

export interface Exporter {
  level?: number
  export(message: Message): void
}

export interface LoggerOptions {
  name: string
  level?: number
}

export interface LoggerService {
  (name?: string): Logger
}

export class Logger {
  public name: string
  public level: number | undefined
  error!: LoggerMethod
  info!: LoggerMethod
  warn!: LoggerMethod
  debug!: LoggerMethod

  constructor(options: LoggerOptions, private service: LoggerService) {
    this.name = options.name
    this.level = options.level
    this.error = this._method('error')
    this.info = this._method('info')
    this.warn = this._method('warn')
    this.debug = this._method('debug')
  }

  private _method(type: LoggerType): LoggerMethod {
    return (...args: Any[]) => this.service._log({ name: this.name, type, args })
  }
}

export class LoggerService {
  buffer: Message[] = []
  ctx!: Context
  _snMessage = 0
  _snExporter = 0
  exporters = new Map<number, Exporter>()

  constructor(ctx: Context) {
    const tracker = {
      property: 'ctx',
      noShadow: true,
    }
    const self = createCallable('logger', joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker) as unknown as LoggerService
    Object.assign(self, this)
    self.ctx = ctx
    Object.defineProperty(self, symbols.tracker, { value: tracker })
    self.exporter({
      export: (message) => {
        self.buffer.push(message)
      },
    })
    ctx.reflect.provide('logger', self)
    return self
  }

  exporter(exporter: Exporter) {
    return this.ctx.fiber.effect(() => {
      const id = ++this._snExporter
      this.exporters.set(id, exporter)
      return () => this.exporters.delete(id)
    }, 'ctx.logger.exporter()')
  }

  [symbols.invoke](name?: string): Logger {
    const caller = (this as Any)[symbols.caller] as Context | undefined
    const fiber = (caller ?? this.ctx).fiber
    return new Logger({
      name: name ?? fiber.name,
    }, this)
  }

  _log(message: Omit<Message, 'sn' | 'ts'>) {
    const sn = ++this._snMessage
    const ts = Date.now()
    for (const exporter of this.exporters.values()) {
      if (exporter.level != null && exporter.level < 0) continue
      exporter.export({ sn, ts, ...message })
    }
  }

  error(...args: Any[]) {
    return (this as Any)().error(...args)
  }

  info(...args: Any[]) {
    return (this as Any)().info(...args)
  }

  warn(...args: Any[]) {
    return (this as Any)().warn(...args)
  }

  debug(...args: Any[]) {
    return (this as Any)().debug(...args)
  }
}

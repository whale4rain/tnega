import { describe, expect, it } from 'vitest'

import { Context, type Message } from '../src/index.js'

describe('LoggerService', () => {
  it('exports messages with name, type and args', () => {
    const root = new Context()
    const messages: Message[] = []
    const dispose = root.logger.exporter({
      export: (message) => messages.push(message),
    })

    const logger = root.logger('demo')
    logger.info('hello', 1)
    logger.warn('careful', { code: 2 })

    expect(messages.map(message => [message.name, message.type, message.args])).toEqual([
      ['demo', 'info', ['hello', 1]],
      ['demo', 'warn', ['careful', { code: 2 }]],
    ])
    expect(messages[0]?.sn).toBeGreaterThan(0)
    expect(typeof messages[0]?.ts).toBe('number')

    dispose()
    logger.debug('after')
    expect(messages).toHaveLength(2)
  })

  it('removes exporters when their fiber unloads', async () => {
    const root = new Context()
    const messages: Message[] = []
    const fiber = root.plugin((ctx) => {
      ctx.logger.exporter({
        export: (message) => messages.push(message),
      })
    })
    await fiber

    root.logger('demo').info('inside')
    expect(messages).toHaveLength(1)

    await fiber.dispose()
    root.logger('demo').info('after')
    expect(messages).toHaveLength(1)
  })

  it('skips exporters whose level is negative', () => {
    const root = new Context()
    const messages: Message[] = []
    root.logger.exporter({
      level: -1,
      export: (message) => messages.push(message),
    })

    root.logger('hidden').error('not exported')
    expect(messages).toHaveLength(0)
  })

  it('uses the fiber name for plugin-scoped loggers', async () => {
    const root = new Context()
    const fiber = root.plugin(function namedPlugin(ctx) {
      ctx.logger.info('hello')
    })
    await fiber

    const info = root.logger.buffer.filter(message => message.type === 'info').at(-1)
    expect(info?.name).toBe('namedPlugin')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { QuickjsPtcRuntime } from '../src/index.js'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
function runtime(timeoutMs = 2000): QuickjsPtcRuntime {
  const ctx = new Context()
  contexts.push(ctx)
  return new QuickjsPtcRuntime(ctx, { timeoutMs })
}

describe('QuickJS PTC boundary', () => {
  it('executes JavaScript and only reaches capabilities through bindings', async () => {
    const result = await runtime().execute({
      code: 'const value = await tools.echo({value: 7}); text(value); return value.value + 1;',
      tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' }, execute: async input => input }],
    })
    expect(result).toMatchObject({ ok: true, value: 8, output: ['{"value":7}'] })
  })

  it('provides no direct filesystem, network, subprocess or module capability', async () => {
    const result = await runtime().execute({
      code: 'return [typeof process, typeof require, typeof fetch, typeof fs, typeof setTimeout];', tools: [],
    })
    expect(result).toMatchObject({ ok: true, value: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'] })
  })

  it('terminates non-cooperative loops on deadline', async () => {
    const result = await runtime(100).execute({ code: 'while (true) {}', tools: [] })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/time|deadline/i)
  })

  it('aborts in-flight child work when the caller cancels', async () => {
    const controller = new AbortController()
    let cancelled = false
    const result = runtime().execute({
      code: 'await tools.wait({});', signal: controller.signal,
      tools: [{ name: 'wait', description: 'Wait', parameters: {}, execute: (_input, signal) => new Promise(resolve => {
        signal.addEventListener('abort', () => { cancelled = true; resolve(undefined) }, { once: true })
        controller.abort()
      }) }],
    })
    expect((await result).ok).toBe(false)
    expect(cancelled).toBe(true)
  })

  it('bounds output before it reaches the host', async () => {
    const result = await runtime().execute({ code: 'text("x".repeat(100000));', tools: [] })
    expect(result.ok).toBe(false)
    expect(result.output.join('').length).toBeLessThanOrEqual(64_000)
  })

  it('stops scripts that repeatedly catch call-limit errors', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const service = new QuickjsPtcRuntime(ctx, { maxCalls: 2, timeoutMs: 2000 })
    let calls = 0
    const result = await service.execute({
      code: 'for (let i=0;i<100;i++) { try { await tools.echo({}); } catch {} }',
      tools: [{ name: 'echo', description: 'Echo', parameters: {}, execute: async () => ++calls }],
    })
    expect(result.ok).toBe(false)
    expect(calls).toBe(2)
  })
})

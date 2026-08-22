import { describe, expect, it } from 'vitest'

import { Context, FiberState, symbols } from '../src/index.js'

describe('Context', () => {
  it('creates a root context with core services', () => {
    const root = new Context()

    expect(Context.is(root)).toBe(true)
    expect(Context.is({})).toBe(false)
    expect(root.fiber.uid).toBe(0)
    expect(root.fiber.state).toBe(FiberState.ACTIVE)
    expect(root.events).toBeDefined()
    expect(root.logger).toBeDefined()
    expect(root.reflect).toBeDefined()
    expect(root.registry).toBeDefined()
  })

  it('extend creates a child that inherits services', () => {
    const root = new Context()
    root.provide('answer', 42)

    const child = root.extend()
    expect(Context.is(child)).toBe(true)
    expect(child.get('answer')).toBe(42)
  })

  it('isolate creates a separate service key without polluting the parent', () => {
    const root = new Context()
    root.provide('answer', 42)

    const child = root.isolate('answer')
    child.provide('answer', 1)

    expect(child.get('answer')).toBe(1)
    expect(root.get('answer')).toBe(42)
  })

  it('isolate with the same label shares the same key', () => {
    const root = new Context()
    const label = Symbol('shared')
    const a = root.isolate('answer', label)
    const b = root.isolate('answer', label)

    a.provide('answer', 7)
    expect(b.get('answer')).toBe(7)
    expect(root.get('answer')).toBeUndefined()
  })

  it('intercept stacks configuration layers', () => {
    const root = new Context()
    const first = root.intercept('demo', { a: 1 })
    const second = first.intercept('demo', { b: 2 })

    expect(second[symbols.intercept]!.demo).toEqual({ b: 2 })
    expect(Object.getPrototypeOf(second[symbols.intercept]!)!.demo).toEqual({ a: 1 })
  })

  it('extend meta defines own properties on the child', () => {
    const root = new Context()
    const child = root.extend({ baseUrl: '/child' })
    expect(child.baseUrl).toBe('/child')
    expect(root.baseUrl).toBeUndefined()
  })

  it('child service lookup walks up the parent chain', async () => {
    const root = new Context()
    const provider = root.plugin((ctx) => {
      ctx.provide('parentService', 'root-value')
    })
    await provider

    const child = root.isolate('other')
    expect(child.get('parentService')).toBe('root-value')
  })
})

import { describe, expect, it } from 'vitest'

import { Context, FiberState } from '../src/index.js'

describe('M1 integration', () => {
  it('registers a tool, listener and exporter, then unloads all of them', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin(function calculator(ctx) {
      ctx.provide('tools.add', (left: number, right: number) => left + right)
      ctx.on('invoke.add', (left: number, right: number) => {
        order.push(`add:${left + right}`)
      })
      ctx.logger.exporter({
        export: (message) => order.push(`log:${message.type}`),
      })
      return () => order.push('unmount')
    })
    await fiber

    const add = root.get('tools.add') as (left: number, right: number) => number
    expect(add(1, 2)).toBe(3)
    root.emit('invoke.add', 1, 2)
    expect(order).toEqual(['add:3'])

    await fiber.dispose()
    expect(root.get('tools.add')).toBeUndefined()
    root.emit('invoke.add', 1, 2)
    expect(order).toEqual(['add:3', 'unmount'])
  })

  it('deactivates dependents before provider unload settles and reactivates later', async () => {
    const root = new Context()
    const order: string[] = []
    const dep = root.plugin({
      inject: ['model'],
      apply: () => {
        order.push('dep-mount')
        return () => order.push('dep-unmount')
      },
    })
    await dep
    expect(dep.state).toBe(FiberState.PENDING)

    const provider = root.plugin((ctx) => {
      order.push('provider-mount')
      ctx.provide('model', { name: 'v1' })
    })
    await provider
    await dep
    expect(order).toEqual(['provider-mount', 'dep-mount'])

    await provider.dispose()
    expect(dep.state).toBe(FiberState.PENDING)
    expect(order).toEqual(['provider-mount', 'dep-mount', 'dep-unmount'])

    const provider2 = root.plugin((ctx) => {
      order.push('provider2-mount')
      ctx.provide('model', { name: 'v2' })
    })
    await provider2
    await dep
    expect(dep.state).toBe(FiberState.ACTIVE)
    expect(order).toEqual([
      'provider-mount',
      'dep-mount',
      'dep-unmount',
      'provider2-mount',
      'dep-mount',
    ])
  })

  it('runs isolated candidates without leaving residue', async () => {
    const root = new Context()
    const runs: string[] = []

    async function runCandidate(name: string) {
      const fiber = root.plugin(function candidate(ctx) {
        ctx.provide('candidate', name)
        ctx.on('candidate-event', () => runs.push(name))
      })
      await fiber

      expect(root.get('candidate')).toBe(name)
      root.emit('candidate-event')
      await fiber.dispose()

      expect(root.get('candidate')).toBeUndefined()
      root.emit('candidate-event')
    }

    await runCandidate('alpha')
    await runCandidate('beta')
    expect(runs).toEqual(['alpha', 'beta'])
  })

  it('keeps the root runtime untouched when a candidate fails', async () => {
    const root = new Context()
    root.provide('baseline', 1)

    const bad = root.plugin((ctx) => {
      ctx.on('candidate-event', () => {})
      throw new Error('candidate crashed')
    })
    await expect(bad).rejects.toThrow('candidate crashed')

    expect(root.get('baseline')).toBe(1)
    root.emit('candidate-event')
  })
})

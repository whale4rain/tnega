import { describe, expect, test } from 'vitest'
import { closeDesktopRuntime } from '../src/shutdown.js'

describe('desktop runtime shutdown', () => {
  test('waits for the local runtime to close before resolving', async () => {
    let closed = false
    let release: (() => void) | undefined
    const closedPromise = new Promise<void>(resolve => {
      release = resolve
    })

    const shutdown = closeDesktopRuntime({
      close: async () => {
        await closedPromise
        closed = true
      },
    })

    await Promise.resolve()
    expect(closed).toBe(false)
    release?.()
    await shutdown
    expect(closed).toBe(true)
  })
})

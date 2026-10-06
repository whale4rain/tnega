import { afterEach, describe, expect, test, vi } from 'vitest'
import { closeDesktopRuntime, finishDesktopShutdown } from '../src/shutdown.js'

afterEach(() => vi.useRealTimers())

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

  test('still closes the browser and exits when runtime cleanup fails', async () => {
    const error = new Error('runtime close failed')
    const closeBrowser = vi.fn(async () => {})
    const finish = vi.fn(() => false)
    const forceExit = vi.fn()
    const reportError = vi.fn()
    await finishDesktopShutdown({
      closeRuntime: async () => { throw error }, closeBrowser, finish, forceExit, reportError,
    })
    expect(reportError).toHaveBeenCalledWith(error)
    expect(closeBrowser).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    expect(forceExit).not.toHaveBeenCalled()
  })

  test('forces exit when runtime cleanup never settles', async () => {
    vi.useFakeTimers()
    const forceExit = vi.fn()
    void finishDesktopShutdown({
      closeRuntime: () => new Promise(() => {}), closeBrowser: async () => {},
      finish: () => false, forceExit, reportError: vi.fn(),
    }, 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(forceExit).toHaveBeenCalledOnce()
  })

  test('keeps the exit deadline while waiting for the update installer', async () => {
    vi.useFakeTimers()
    const forceExit = vi.fn()
    await finishDesktopShutdown({
      closeRuntime: async () => {}, closeBrowser: async () => {},
      finish: () => true, forceExit, reportError: vi.fn(),
    }, 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(forceExit).toHaveBeenCalledOnce()
  })

  test('forces exit if the installer throws', async () => {
    const forceExit = vi.fn()
    const reportError = vi.fn()
    const error = new Error('installer failed')
    await finishDesktopShutdown({
      closeRuntime: async () => {}, closeBrowser: async () => {},
      finish: () => { throw error }, forceExit, reportError,
    })
    expect(reportError).toHaveBeenCalledWith(error)
    expect(forceExit).toHaveBeenCalledOnce()
  })
})

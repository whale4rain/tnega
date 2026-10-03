import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { summarizeUpdateError, UpdateController, type UpdaterLike, type UpdateState } from '../src/updater.js'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = true
  checks = 0
  installs: Array<[boolean | undefined, boolean | undefined]> = []
  next: (() => void) | undefined
  checkForUpdates(): Promise<unknown> {
    this.checks += 1
    this.emit('checking-for-update')
    this.next?.()
    return Promise.resolve(undefined)
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}

describe('desktop self-update', () => {
  test('development builds report that updates are unsupported', async () => {
    const controller = new UpdateController({ version: '0.4.5', updater: undefined })
    expect(controller.state()).toEqual({ status: 'unsupported', version: '0.4.5' })
    expect(await controller.check()).toEqual({ status: 'unsupported', version: '0.4.5' })
    expect(controller.installOnExit()).toBe(false)
  })

  test('downloads a new release in the background and installs it on request', async () => {
    const updater = new FakeUpdater()
    const controller = new UpdateController({ version: '0.4.5', updater, now: () => 42 })
    const states: UpdateState[] = []
    controller.subscribe(state => states.push(state))
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)

    updater.next = () => {
      updater.emit('update-available', { version: '0.4.6' })
      updater.emit('download-progress', { percent: 41.6 })
      updater.emit('update-downloaded', { version: '0.4.6' })
    }
    await controller.check()
    expect(states.map(state => state.status)).toEqual(['checking', 'downloading', 'downloading', 'ready'])
    expect(states[2]).toMatchObject({ next: '0.4.6', percent: 42 })

    // A ready update is not re-checked, and a later error does not hide it.
    await controller.check()
    expect(updater.checks).toBe(1)
    updater.emit('error', new Error('offline'))
    expect(controller.state()).toEqual({ status: 'ready', version: '0.4.5', next: '0.4.6' })

    controller.install()
    expect(updater.installs).toEqual([[true, true]])
  })

  test('records failures and up-to-date checks', async () => {
    const updater = new FakeUpdater()
    const controller = new UpdateController({ version: '0.4.5', updater, now: () => 7 })
    updater.next = () => { updater.emit('update-not-available') }
    expect(await controller.check()).toEqual({ status: 'idle', version: '0.4.5', checkedAt: 7 })

    updater.next = undefined
    updater.checkForUpdates = vi.fn(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')))
    expect(await controller.check()).toEqual({
      status: 'error', version: '0.4.5', message: 'Could not reach GitHub to check for updates.', checkedAt: 7,
    })
    expect(controller.installOnExit()).toBe(false)
  })

  test('installs silently without relaunching when the app exits with an update ready', () => {
    const updater = new FakeUpdater()
    const controller = new UpdateController({ version: '0.4.5', updater })
    updater.emit('update-downloaded', { version: '0.5.0' })
    expect(controller.installOnExit()).toBe(true)
    expect(updater.installs).toEqual([[true, false]])
  })
})

describe('update error messages', () => {
  test('names a release that has no feed instead of dumping the HTTP error', () => {
    const raw = new Error([
      'Cannot find latest.yml in the latest release artifacts (https://github.com/whale4rain/tnega/releases/download/v0.4.6/latest.yml): HttpError: 404 "method: GET"',
      'Headers: { "cache-control": "no-cache" }',
      '    at createHttpError (httpExecutor.js:53:12)',
    ].join('\n'))
    expect(summarizeUpdateError(raw)).toBe('The latest release (v0.4.6) has no update feed (latest.yml) yet.')
  })

  test('reports offline checks plainly and keeps other errors to one short line', () => {
    expect(summarizeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('Could not reach GitHub to check for updates.')
    expect(summarizeUpdateError(new Error(`sha512 checksum mismatch\n${'x'.repeat(500)}`))).toBe('sha512 checksum mismatch')
    expect(summarizeUpdateError('y'.repeat(300))).toHaveLength(158)
  })
})

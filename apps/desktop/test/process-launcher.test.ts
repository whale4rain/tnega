import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureProcessLauncher, localExecutionProvider } from '../../../packages/execution/src/index.js'
import { desktopProcessLauncher, type NodeUtilityFork, type NodeUtilityProcess } from '../src/process-launcher.js'

class Utility extends EventEmitter implements NodeUtilityProcess {
  pid: number | undefined
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly output = new PassThrough()
  readonly errorOutput = new PassThrough()
  constructor() {
    super()
    queueMicrotask(() => { this.output.pipe(this.stdout); this.errorOutput.pipe(this.stderr) })
  }
  kill = vi.fn(() => { this.complete(0); return true })
  complete(code: number): void {
    this.emit('exit', code)
    this.output.end()
    this.errorOutput.end()
    this.stdout.removeAllListeners()
    this.stderr.removeAllListeners()
  }
}

const executable = 'C:\\Tnega\\Tnega.exe'
const request = {
  argv: [executable, 'C:\\Tnega\\runner.js', '--', 'cmd.exe', '/c', 'echo ok'],
  cwd: process.cwd(), env: { ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1', TNEGA_WORKER_TEST: 'worker' },
}
let restore: (() => void) | undefined
afterEach(() => { restore?.(); restore = undefined })

describe('desktop Node worker launcher', () => {
  it('uses the native utility entry with exact argv, cwd and child-only env', async () => {
    const utility = new Utility()
    const fork = vi.fn<NodeUtilityFork>(() => utility)
    const launcher = desktopProcessLauncher(fork, executable)
    restore = configureProcessLauncher(launcher)
    const result = localExecutionProvider.runProcess(request)
    await Promise.resolve()
    expect(fork).toHaveBeenCalledWith(request.argv[1], request.argv.slice(2), expect.objectContaining({
      cwd: request.cwd, stdio: 'pipe', env: expect.objectContaining({ TNEGA_WORKER_TEST: 'worker' }),
    }))
    const launch = fork.mock.calls[0]
    if (!launch) throw new Error('worker was not launched')
    expect(launch[2].env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(launch[2].env.TNEGA_DESKTOP_ACL_RUNNER).toBeUndefined()
    expect(launcher({ ...request, argv: ['other.exe', 'runner.js'] })).toBeUndefined()
    utility.output.write('out')
    utility.errorOutput.write('err')
    utility.complete(7)
    await expect(result).resolves.toMatchObject({ stdout: 'out', stderr: 'err', exitCode: 7 })
    expect(process.env.TNEGA_WORKER_TEST).toBeUndefined()
  })

  it('does not replace ordinary commands or Electron CLI switches', () => {
    const fork = vi.fn(() => new Utility())
    const launcher = desktopProcessLauncher(fork, executable)
    expect(launcher({ ...request, env: {} })).toBeUndefined()
    expect(launcher({ ...request, env: { ELECTRON_RUN_AS_NODE: '1' } })).toBeUndefined()
    expect(launcher({ ...request, argv: [executable, '-e', 'text'] })).toBeUndefined()
    expect(fork).not.toHaveBeenCalled()
  })

  it('captures output written after the exit notification, before pipes finish', async () => {
    const utility = new Utility()
    restore = configureProcessLauncher(desktopProcessLauncher(() => utility, executable))
    const result = localExecutionProvider.runProcess(request)
    await Promise.resolve()
    utility.emit('exit', 0)
    utility.output.end('tail')
    utility.errorOutput.end('last')
    await expect(result).resolves.toMatchObject({ stdout: 'tail', stderr: 'last', exitCode: 0 })
  })

  it('kills a worker cancelled before its asynchronous PID becomes available', async () => {
    const utility = new Utility()
    restore = configureProcessLauncher(desktopProcessLauncher(() => utility, executable))
    const controller = new AbortController()
    const result = localExecutionProvider.runProcess({ ...request, signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toThrow('cancelled')
    utility.pid = 1234
    utility.emit('spawn')
    expect(utility.kill).toHaveBeenCalledOnce()
  })

  it('retains capture limits and reports utility launch failure', async () => {
    const utility = new Utility()
    restore = configureProcessLauncher(desktopProcessLauncher(() => utility, executable))
    const result = localExecutionProvider.runProcess({ ...request, maxBuffer: 3 })
    await Promise.resolve()
    utility.output.write('abcdef')
    utility.complete(0)
    await expect(result).resolves.toMatchObject({ stdout: 'abc', stdoutTruncated: true })
    const failed = new Utility()
    restore()
    restore = configureProcessLauncher(desktopProcessLauncher(() => failed, executable))
    const failure = localExecutionProvider.runProcess(request)
    failed.emit('error', 'FatalError')
    failed.complete(1)
    await expect(failure).resolves.toMatchObject({ exitCode: 1, stderr: 'FatalError' })
  })

  it('does not resurrect a disposed launcher when overlapping installs restore', async () => {
    const first = vi.fn(() => undefined)
    const firstRestore = configureProcessLauncher(first)
    restore = configureProcessLauncher(() => undefined)
    firstRestore()
    restore()
    restore = undefined
    const result = await localExecutionProvider.runProcess({ argv: [process.execPath, '-e', 'process.stdout.write("normal")'], cwd: process.cwd() })
    expect(result.stdout).toBe('normal')
    expect(first).not.toHaveBeenCalled()
  })
})

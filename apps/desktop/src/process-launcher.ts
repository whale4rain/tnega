import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, type Readable } from 'node:stream'
import type { BackgroundProcessRequest, ExecutionChild, ProcessLauncher } from '@tnega/execution'

export interface NodeUtilityProcess extends EventEmitter {
  readonly pid: number | undefined
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(): boolean
}

export type NodeUtilityFork = (
  modulePath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'pipe'; serviceName: string },
) => NodeUtilityProcess

/** Electron's native utility launcher disables Windows startup cursor feedback. */
export function desktopProcessLauncher(fork: NodeUtilityFork, executable: string): ProcessLauncher {
  return (request: BackgroundProcessRequest) => {
    const [command, modulePath, ...args] = request.argv
    // Only replace the desktop's Node-mode workers, never arbitrary programs.
    if (command !== executable || request.env?.ELECTRON_RUN_AS_NODE !== '1'
      || request.env.TNEGA_DESKTOP_ACL_RUNNER !== '1'
      || !modulePath || modulePath.startsWith('-')) return undefined
    const env = { ...process.env, ...request.env }
    // Utility processes already run Node; this bootstrap flag would bypass
    // Electron's utility entry point and prevent the worker from starting.
    delete env.ELECTRON_RUN_AS_NODE
    delete env.TNEGA_DESKTOP_ACL_RUNNER
    return new UtilityChild(fork(modulePath, args, {
      cwd: request.cwd, env, stdio: 'pipe', serviceName: 'Tnega Agent Worker',
    }))
  }
}

class UtilityChild extends EventEmitter implements ExecutionChild {
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  private processId: number | undefined
  private killedBeforeSpawn = false
  private code: number | null | undefined
  private pendingStreams = 0
  private closed = false

  constructor(private readonly process: NodeUtilityProcess) {
    super()
    const outputs = [process.stdout, process.stderr].map(source => {
      if (!source) return null
      if (!(source instanceof Duplex)) {
        process.kill()
        throw new Error('Electron utility output must expose its native pipe through a Duplex stream')
      }
      const output = new PassThrough()
      const pair = { source, output, connected: false }
      // Capture the native Socket upstream. Electron 44 clears listeners on
      // its own PassThrough at exit; piping the Socket directly keeps output,
      // backpressure and EOF intact, including data still in the OS pipe.
      source.on('pipe', (upstream: Readable) => {
        pair.connected = true
        upstream.unpipe(source)
        upstream.pipe(output)
        upstream.once('error', error => this.fail(error))
      })
      return pair
    })
    this.stdout = outputs[0]?.output ?? null
    this.stderr = outputs[1]?.output ?? null
    this.processId = process.pid
    process.once('spawn', () => {
      this.processId = process.pid
      if (this.killedBeforeSpawn) process.kill()
    })
    for (const stream of [this.stdout, this.stderr]) {
      if (!stream || stream.destroyed) continue
      this.pendingStreams += 1
      stream.once('close', () => { this.pendingStreams -= 1; this.finish() })
    }
    process.once('exit', (code: number) => {
      this.code = code
      queueMicrotask(() => {
        for (const pair of outputs) {
          if (!pair || pair.output.destroyed || pair.output.writableEnded) continue
          // A failed launch may never connect its native stdout/stderr pipes.
          if (!pair.connected) pair.output.end()
        }
        this.finish()
      })
    })
    process.once('error', (error: unknown) => this.fail(error))
  }

  get pid(): number | undefined { return this.processId ?? this.process.pid }
  kill(): boolean {
    if (this.pid === undefined && this.code === undefined) { this.killedBeforeSpawn = true; return true }
    return this.process.kill()
  }

  private finish(): void {
    if (this.closed || this.code === undefined || this.pendingStreams > 0) return
    this.closed = true
    this.emit('close', this.code, null)
  }

  private fail(error: unknown): void {
    this.kill()
    this.emit('error', error instanceof Error ? error : new Error(String(error)))
    this.stdout?.destroy()
    this.stderr?.destroy()
    this.code ??= 1
    this.finish()
  }
}

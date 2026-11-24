import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolveInside } from '@tnega/fs-sandbox'
import { RpcError, RpcErrorCode, type DaemonWorkspace } from '@tnega/daemon-protocol'
import type { ExposedService } from './services.js'

/** What a piped process sends its follower: output chunks, in order. */
export type PipeEvent = { type: 'stdout' | 'stderr'; data: string }

/** Output a process makes before anyone follows it, kept until the first follower. */
const EARLY_OUTPUT_LIMIT = 1024 * 1024

interface Piped {
  child: ChildProcessWithoutNullStreams
  /** Output from before the follower attached. */
  early: PipeEvent[]
  earlyBytes: number
  follower: ((event: PipeEvent) => void) | undefined
  /** Set once the process is gone: how the stream ends. */
  exit: string | undefined
  onExit: Set<(reason: string) => void>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new RpcError(`${field} must be a string`, RpcErrorCode.INVALID_PARAMS)
  return value
}

function argv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string') || !value[0]) {
    throw new RpcError('argv must be a non-empty list of strings', RpcErrorCode.INVALID_PARAMS)
  }
  return value
}

function env(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new RpcError('env must be an object of strings', RpcErrorCode.INVALID_PARAMS)
  const out: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new RpcError(`env.${name} must be a string`, RpcErrorCode.INVALID_PARAMS)
    out[name] = item
  }
  return out
}

function kill(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  // The process leads its own group (POSIX): its children go with it.
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* the group is already gone */ }
  }
  child.kill('SIGKILL')
}

/**
 * Long-lived processes the runtime talks to over stdin and stdout, such as a
 * coding session's MCP servers. Only a daemon that is itself the sandbox (a
 * box) serves these: the process runs with no inner sandbox, in a folder
 * inside a workspace this daemon announced. `start` answers an id; `attach`
 * streams the output (anything written before it is kept for it) and ends
 * when the process exits; `write` feeds stdin; `close`, or the end of the
 * stream, kills the process and its children. Closing the daemon kills them
 * all.
 */
export function exposePipes(workspaces: readonly DaemonWorkspace[]): { service: ExposedService; dispose(): void } {
  const pipes = new Map<string, Piped>()
  const inside = async (path: string): Promise<string> => {
    for (const workspace of workspaces) {
      try {
        return await resolveInside(workspace.path, path)
      } catch {
        // Try the next workspace.
      }
    }
    throw new RpcError(`${path} is not inside a workspace this daemon serves`, RpcErrorCode.WORKSPACE_DENIED, { name: 'WorkspaceDeniedError', code: 'WORKSPACE_DENIED' })
  }
  const piped = (id: unknown): Piped => {
    const entry = pipes.get(text(id, 'id'))
    if (!entry) throw new RpcError(`no process ${String(id)}`, RpcErrorCode.INVALID_PARAMS)
    return entry
  }
  const service: ExposedService = {
    calls: {
      start: async ([cwdArg, argvArg, envArg]) => {
        const cwd = await inside(text(cwdArg, 'cwd'))
        if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) {
          throw new RpcError(`${text(cwdArg, 'cwd')} is not a folder`, RpcErrorCode.INVALID_PARAMS)
        }
        const [command, ...args] = argv(argvArg)
        const child = spawn(command ?? '', args, {
          cwd,
          env: { ...process.env, ...env(envArg) },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
        const id = randomUUID()
        const entry: Piped = { child, early: [], earlyBytes: 0, follower: undefined, exit: undefined, onExit: new Set() }
        const deliver = (event: PipeEvent): void => {
          if (entry.follower) { entry.follower(event); return }
          entry.early.push(event)
          entry.earlyBytes += event.data.length
          while (entry.earlyBytes > EARLY_OUTPUT_LIMIT && entry.early.length > 1) entry.earlyBytes -= entry.early.shift()?.data.length ?? 0
        }
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (data: string) => deliver({ type: 'stdout', data }))
        child.stderr.on('data', (data: string) => deliver({ type: 'stderr', data }))
        // A write after the process died is reported by its exit, not as a crash of the daemon.
        child.stdin.on('error', () => undefined)
        const finish = (reason: string): void => {
          if (entry.exit !== undefined) return
          entry.exit = reason
          for (const listener of [...entry.onExit]) listener(reason)
        }
        child.on('error', error => finish(`failed: ${error.message}`))
        child.on('close', (code, signal) => finish(signal ? `killed by ${signal}` : `exited with ${code ?? 0}`))
        pipes.set(id, entry)
        // A program that is not there fails on the next tick; say so to the caller, not to a stream.
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', () => resolve())
          child.once('error', error => { pipes.delete(id); reject(new RpcError(`could not start ${command}: ${error.message}`, RpcErrorCode.INVALID_PARAMS)) })
        })
        return id
      },
      write: ([id, data]) => {
        const entry = piped(id)
        if (entry.exit === undefined) entry.child.stdin.write(text(data, 'data'))
        return null
      },
      close: ([id]) => {
        const key = text(id, 'id')
        const entry = pipes.get(key)
        if (entry) {
          pipes.delete(key)
          kill(entry.child)
        }
        return null
      },
    },
    streams: {
      attach: ([id], emit, end) => {
        const entry = piped(id)
        if (entry.follower) throw new RpcError(`process ${String(id)} already has a follower`, RpcErrorCode.INVALID_PARAMS)
        for (const event of entry.early.splice(0)) emit(event)
        entry.earlyBytes = 0
        entry.follower = emit
        const ended = (reason: string): void => {
          pipes.delete(text(id, 'id'))
          end(reason)
        }
        if (entry.exit !== undefined) {
          ended(entry.exit)
          return () => undefined
        }
        entry.onExit.add(ended)
        // Nobody reads it any more (closed, or the connection never came back): the process goes too.
        return () => {
          entry.onExit.delete(ended)
          pipes.delete(text(id, 'id'))
          kill(entry.child)
        }
      },
    },
  }
  return {
    service,
    dispose: () => {
      for (const entry of pipes.values()) kill(entry.child)
      pipes.clear()
    },
  }
}

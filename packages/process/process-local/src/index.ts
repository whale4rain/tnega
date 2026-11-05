import { spawn, spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { Context } from '@tnega/core'
import {
  BACKGROUND_OUTPUT_LIMIT,
  ProcessBoundary,
  type BackgroundProcess,
  type BackgroundProcessRequest,
  type BackgroundShellRequest,
  type ExecutionProvider,
  type OutputListener,
  type ProcessRequest,
  type ProcessResult,
  type ShellRequest,
  type ShellResult,
} from '@tnega/process'
import { assertPublicHttpUrl, networkFetch } from './network.js'
import { describeShell, shellCommandArgv, systemShell } from './shell.js'

export * from './shell.js'
export * from './network.js'

/** The process lifecycle needed by local execution, independent of its host. */
export interface ExecutionChild {
  readonly pid?: number | undefined
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export type ProcessLauncher = (request: BackgroundProcessRequest) => ExecutionChild | undefined

const hostLaunchers: ProcessLauncher[] = []

/** Install a host-specific launcher; undefined results use the normal argv spawn. */
export function configureProcessLauncher(launcher: ProcessLauncher): () => void {
  // Keep each installation distinct, even if the same function is installed twice.
  const installed: ProcessLauncher = request => launcher(request)
  hostLaunchers.push(installed)
  return () => {
    const index = hostLaunchers.indexOf(installed)
    if (index >= 0) hostLaunchers.splice(index, 1)
  }
}


function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * `taskkill /t` walks the tree once, so a child the shell was creating at that
 * moment survives as an orphan. Windows keeps the dead parent's PID in
 * `ParentProcessId`, so sweep descendants of the killed root by that link.
 */
async function killOrphans(root: number): Promise<void> {
  const script = `$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
$queue = [System.Collections.Generic.Queue[uint32]]::new(); $queue.Enqueue(${root})
while ($queue.Count) { $p = $queue.Dequeue(); foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and $c.ProcessId -ne $p) { $queue.Enqueue($c.ProcessId); Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue } } }`
  const root32 = process.env.SystemRoot ?? 'C:\\Windows'
  await new Promise<void>((resolve) => {
    const sweeper = spawn(`${root32}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { sweeper.kill(); resolve() }, 10_000)
    sweeper.on('error', () => { clearTimeout(timer); resolve() })
    sweeper.on('exit', () => { clearTimeout(timer); resolve() })
  })
}

async function killProcessTree(child: ExecutionChild): Promise<void> {
  const pid = child.pid
  if (pid === undefined) { child.kill('SIGKILL'); return }
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => resolve())
      killer.on('exit', () => resolve())
    })
    await killOrphans(pid)
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Process group already gone.
    }
    child.kill('SIGKILL')
  }
}

/**
 * Longest a cut-short run waits for its tree to die before reporting. On
 * Windows `taskkill` plus the orphan sweep can take seconds; the kill carries
 * on behind the report instead of holding the stop button.
 */
const KILL_SETTLE_MS = 1_000

function killSettleDelay(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, KILL_SETTLE_MS).unref())
}

interface CapturedOutput {
  exitCode: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
}

/** Raw output bytes up to a cap, decoded once so multi-byte characters never split across chunks. */
class ByteCapture {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  truncated = false

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const room = this.limit - this.bytes
    if (chunk.length > room) this.truncated = true
    if (room <= 0) return
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
    this.chunks.push(kept)
    this.bytes += kept.length
  }

  text(): string {
    return decodeOutput(Buffer.concat(this.chunks))
  }
}

let oemEncoding: string | undefined

/** The console code page a Windows program falls back to, as a TextDecoder label. */
function windowsOemEncoding(): string {
  if (oemEncoding) return oemEncoding
  const probe = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'latin1', windowsHide: true, timeout: 5_000 })
  const page = Number(/(\d{3,5})/.exec(probe.stdout ?? '')?.[1])
  const labels: Record<number, string> = {
    936: 'gbk', 54936: 'gb18030', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 65001: 'utf-8', 866: 'ibm866',
  }
  oemEncoding = labels[page] ?? (page >= 1250 && page <= 1258 ? `windows-${page}` : 'windows-1252')
  return oemEncoding
}

/**
 * Output is UTF-8 almost always. A Windows program that cannot switch its
 * console to UTF-8 (PowerShell in ConstrainedLanguage under the read-only
 * sandbox, legacy tools) writes the OEM code page instead.
 */
export function decodeOutput(bytes: Buffer, platform = process.platform): string {
  const strict = new TextDecoder('utf-8', { fatal: true })
  // A capped capture can end inside a character; that alone is not a different encoding.
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    try {
      return strict.decode(bytes.subarray(0, bytes.length - trim))
    } catch {
      // Try a shorter tail, then another encoding.
    }
  }
  if (platform !== 'win32') return bytes.toString('utf8')
  try {
    return new TextDecoder(windowsOemEncoding()).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

interface RunOptions {
  timeoutMs: number
  maxBuffer: number
  signal?: AbortSignal
  /** Prefix used in timeout and cancellation messages, e.g. `shell command`. */
  label: string
  onOutput?: OutputListener
}

/**
 * Drive one child process to completion under a timeout, an optional caller
 * signal, and a stdout byte cap. A rejected promise means the run was cut short
 * (timeout, cancellation, or a failed spawn); anything the child itself did
 * resolves with its exit code.
 */
function runChild(spawnChild: () => ExecutionChild, options: RunOptions): Promise<CapturedOutput> {
  const { timeoutMs, maxBuffer, signal, label, onOutput } = options
  const report = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
    try {
      onOutput?.(chunk, stream)
    } catch {
      // Progress reporting must never break the run it observes.
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawnChild()
    const stdout = new ByteCapture(maxBuffer)
    const stderr = new ByteCapture(maxBuffer)
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let onAbort: () => void = () => {}
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const fail = (message: string): void => {
      finish(() => {
        void Promise.race([killProcessTree(child), killSettleDelay()]).finally(() => reject(new Error(message)))
      })
    }
    onAbort = () => fail(`${label} cancelled`)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => fail(`${label} timed out after ${timeoutMs}ms`), timeoutMs)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
      report(chunk, 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
      report(chunk, 'stderr')
    })
    child.on('error', (error) => {
      finish(() => resolve({
        exitCode: 1,
        stdout: stdout.text(),
        stderr: errorMessage(error),
        stdoutTruncated: stdout.truncated,
      }))
    })
    child.on('close', (code, closeSignal) => {
      finish(() => resolve({
        exitCode: code ?? 1,
        stdout: stdout.text(),
        stderr: closeSignal ? `killed by ${closeSignal}` : stderr.text(),
        stdoutTruncated: stdout.truncated,
      }))
    })
  })
}

function spawnOptions(
  cwd: string,
  stdin: 'ignore' | 'pipe',
): Parameters<typeof spawn>[2] {
  return {
    cwd,
    windowsHide: true,
    stdio: [stdin, 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? {} : { detached: true }),
  }
}

/** Spawn the system shell directly with the command as one argument: no cmd.exe hop, no console window. */
function spawnShell(command: string, cwd: string, env?: Readonly<Record<string, string>>): ExecutionChild {
  const [file, ...args] = shellCommandArgv(systemShell(), command)
  return spawnProcess({ argv: [file!, ...args], cwd, ...(env ? { env } : {}) })
}

function spawnProcess(request: BackgroundProcessRequest): ExecutionChild {
  const [command, ...args] = request.argv
  if (!command) throw new Error('process argv must name an executable')
  return hostLaunchers.at(-1)?.(request) ?? spawn(command, args, {
    ...spawnOptions(request.cwd, 'ignore'), shell: false,
    ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
  })
}

function runLocalShell(request: ShellRequest): Promise<ShellResult> {
  return runChild(
    () => spawnShell(request.command, request.cwd, request.env),
    {
      timeoutMs: request.timeoutMs ?? 15_000,
      maxBuffer: request.maxBuffer ?? 1024 * 1024,
      label: 'shell command',
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onOutput ? { onOutput: request.onOutput } : {}),
    },
  )
}

function runLocalProcess(request: ProcessRequest): Promise<ProcessResult> {
  return runChild(
    // Nothing ever writes to a child's stdin here, and an open pipe makes a
    // reader (ripgrep without an explicit path) block forever, so it gets EOF
    // instead.
    () => spawnProcess(request),
    {
      timeoutMs: request.timeoutMs ?? 15_000,
      maxBuffer: request.maxBuffer ?? 1024 * 1024,
      label: 'process',
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onOutput ? { onOutput: request.onOutput } : {}),
    },
  )
}

function background(child: ExecutionChild): BackgroundProcess {
  let output = ''
  let code: number | null | undefined
  const append = (chunk: Buffer): void => {
    output += chunk.toString('utf8')
    if (output.length > BACKGROUND_OUTPUT_LIMIT) output = output.slice(-BACKGROUND_OUTPUT_LIMIT)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const exited = new Promise<number | null>(resolve => {
    child.on('error', error => {
      output += `
${errorMessage(error)}`
      code = 1
      resolve(1)
    })
    child.on('close', exitCode => {
      code = exitCode
      resolve(exitCode)
    })
  })
  return {
    get pid() { return child.pid },
    output: () => output,
    exitCode: () => code,
    exited,
    async kill() {
      if (code !== undefined) return
      await killProcessTree(child)
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))])
    },
  }
}

async function startLocalShell(request: BackgroundShellRequest): Promise<BackgroundProcess> {
  return background(spawnShell(request.command, request.cwd, request.env))
}

async function startLocalProcess(request: BackgroundProcessRequest): Promise<BackgroundProcess> {
  return background(spawnProcess(request))
}

export const localExecutionProvider: ExecutionProvider = {
  runShell: runLocalShell,
  runProcess: runLocalProcess,
  startShell: startLocalShell,
  startProcess: startLocalProcess,
  describeShell: () => describeShell(systemShell()),
  async fetchHttp(request) {
    const init: RequestInit = { redirect: 'manual' }
    if (request.headers) init.headers = request.headers
    if (request.signal) init.signal = request.signal
    let url = new URL(request.url)
    let response: Response | undefined
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!request.allowPrivate) await assertPublicHttpUrl(url)
      response = await networkFetch(url, init)
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location || redirects === 5) throw new Error('HTTP redirect limit reached')
      await response.body?.cancel()
      url = new URL(location, url)
    }
    if (!response) throw new Error('HTTP request produced no response')
    const buffer = Buffer.from(await response.arrayBuffer())
    const maxBytes = request.maxBytes ?? 256 * 1024
    const truncated = buffer.byteLength > maxBytes
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    return {
      status: response.status,
      ok: response.ok,
      headers,
      body: buffer.subarray(0, maxBytes).toString('utf8'),
      truncated,
    }
  },
}


/**
 * The local Provider of `ctx.process`, undecorated. The composition layer
 * mounts it only where no sandbox applies; a sandboxed scope provides the
 * decorated chain instead (see `@tnega/runtime`'s `capability:sandbox`).
 */
export const processLocal = {
  name: 'process-local',
  apply(ctx: Context): void {
    new ProcessBoundary(ctx, localExecutionProvider)
  },
}

export const name = '@tnega/process-local'

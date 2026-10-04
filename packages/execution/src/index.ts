import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { shellCommandArgv, systemShell } from './shell.js'

export * from './shell.js'

export interface ShellRequest {
  command: string
  cwd: string
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
  /**
   * Run outside any sandbox decorator. Set only by a tool whose call was
   * approved for escalation (`ToolExecuteOptions.approvedElevation`).
   */
  unsandboxed?: boolean
}

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * One shell-free process run. `argv` is a plain argument vector, so no quoting
 * layer exists between the caller and the executable and a model-controlled
 * value can never be re-parsed as shell syntax.
 */
export interface ProcessRequest {
  /** Child-only overrides; other host environment variables are inherited. */
  env?: Readonly<Record<string, string>>
  /** Full argument vector; element 0 is the executable. */
  argv: readonly string[]
  cwd: string
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
}

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when stdout hit `maxBuffer`, so the capture is not a complete stream. */
  stdoutTruncated: boolean
}

export interface HttpRequest {
  url: string
  headers?: Record<string, string>
  signal?: AbortSignal
  maxBytes?: number
  allowPrivate?: boolean
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  truncated: boolean
}

/** Replaceable execution boundary used by builtin network/shell/search tools. */
/** A long-running command, e.g. a dev server, started without waiting for it to exit. */
export interface BackgroundShellRequest {
  command: string
  cwd: string
  /** See {@link ShellRequest.unsandboxed}. */
  unsandboxed?: boolean
}

export interface BackgroundProcessRequest {
  env?: Readonly<Record<string, string>>
  argv: readonly string[]
  cwd: string
}

/** Handle to a running child. Output is the combined stdout/stderr tail. */
export interface BackgroundProcess {
  readonly pid: number | undefined
  /** Combined stdout and stderr, most recent `maxOutput` characters. */
  output(): string
  /** Exit code once exited, `null` when killed by a signal, `undefined` while running. */
  exitCode(): number | null | undefined
  /** Settles when the process exits. */
  readonly exited: Promise<number | null>
  /** Kill the whole process tree. */
  kill(): Promise<void>
}

export interface ExecutionProvider {
  runShell(request: ShellRequest): Promise<ShellResult>
  runProcess(request: ProcessRequest): Promise<ProcessResult>
  fetchHttp(request: HttpRequest): Promise<HttpResponse>
  /** Start a shell command in the background; absent when the boundary cannot. */
  startShell?(request: BackgroundShellRequest): Promise<BackgroundProcess>
  /** Start an argv process in the background; absent when the boundary cannot. */
  startProcess?(request: BackgroundProcessRequest): Promise<BackgroundProcess>
}

/** Characters of output a background process keeps. */
export const BACKGROUND_OUTPUT_LIMIT = 64 * 1024

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

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => resolve())
      killer.on('exit', () => resolve())
    })
    await killOrphans(child.pid)
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Process group already gone.
    }
    child.kill('SIGKILL')
  }
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
}

/**
 * Drive one child process to completion under a timeout, an optional caller
 * signal, and a stdout byte cap. A rejected promise means the run was cut short
 * (timeout, cancellation, or a failed spawn); anything the child itself did
 * resolves with its exit code.
 */
function runChild(spawnChild: () => ChildProcess, options: RunOptions): Promise<CapturedOutput> {
  const { timeoutMs, maxBuffer, signal, label } = options
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
        void killProcessTree(child).finally(() => reject(new Error(message)))
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
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
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
function spawnShell(command: string, cwd: string): ChildProcess {
  const [file, ...args] = shellCommandArgv(systemShell(), command)
  return spawn(file!, args, { ...spawnOptions(cwd, 'ignore'), shell: false })
}

function runLocalShell(request: ShellRequest): Promise<ShellResult> {
  return runChild(
    () => spawnShell(request.command, request.cwd),
    {
      timeoutMs: request.timeoutMs ?? 15_000,
      maxBuffer: request.maxBuffer ?? 1024 * 1024,
      label: 'shell command',
      ...(request.signal ? { signal: request.signal } : {}),
    },
  )
}

function runLocalProcess(request: ProcessRequest): Promise<ProcessResult> {
  const [command, ...args] = request.argv
  if (!command) throw new Error('process argv must name an executable')
  return runChild(
    // Nothing ever writes to a child's stdin here, and an open pipe makes a
    // reader (ripgrep without an explicit path) block forever, so it gets EOF
    // instead.
    () => spawn(command, args, {
      ...spawnOptions(request.cwd, 'ignore'),
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
      shell: false,
    }),
    {
      timeoutMs: request.timeoutMs ?? 15_000,
      maxBuffer: request.maxBuffer ?? 1024 * 1024,
      label: 'process',
      ...(request.signal ? { signal: request.signal } : {}),
    },
  )
}

function background(child: ChildProcess): BackgroundProcess {
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
    pid: child.pid,
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
  return background(spawnShell(request.command, request.cwd))
}

async function startLocalProcess(request: BackgroundProcessRequest): Promise<BackgroundProcess> {
  const [command, ...args] = request.argv
  if (!command) throw new Error('process argv must name an executable')
  return background(spawn(command, args, {
    ...spawnOptions(request.cwd, 'ignore'), shell: false,
    ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
  }))
}

export const localExecutionProvider: ExecutionProvider = {
  runShell: runLocalShell,
  runProcess: runLocalProcess,
  startShell: startLocalShell,
  startProcess: startLocalProcess,
  async fetchHttp(request) {
    const init: RequestInit = { redirect: 'manual' }
    if (request.headers) init.headers = request.headers
    if (request.signal) init.signal = request.signal
    let url = new URL(request.url)
    let response: Response | undefined
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!request.allowPrivate) await assertPublicHttpUrl(url)
      response = await fetch(url, init)
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

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`unsupported protocol: ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('HTTP destination must be public')
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('HTTP destination must be public')
  }
}

function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const value = address.toLowerCase()
    if (value.startsWith('::ffff:') || value.startsWith('2002:')
      || value.startsWith('64:ff9b:')) return false
    return value !== '::1' && value !== '::' && !value.startsWith('fc')
      && !value.startsWith('fd') && !value.startsWith('fe8')
      && !value.startsWith('fe9') && !value.startsWith('fea') && !value.startsWith('feb')
      && !value.startsWith('ff') && !value.startsWith('2001:db8:')
  }
  const bytes = address.split('.').map(Number)
  if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return false
  const [a, b] = bytes
  return a !== 0 && a !== 10 && a !== 127 && a! < 224
    && !(a === 169 && b === 254) && !(a === 192 && (b === 168 || b === 0))
    && !(a === 100 && b! >= 64 && b! <= 127)
    && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 198 && (b === 18 || b === 19))
}

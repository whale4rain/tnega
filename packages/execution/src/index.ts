import { spawn, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface ShellRequest {
  command: string
  cwd: string
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
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
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let onAbort: () => void = () => {}
    const append = (target: string, text: string, limit: number): string => {
      if (target.length >= limit) return target
      return target + text.slice(0, limit - target.length)
    }
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
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stdout.length + text.length > maxBuffer) stdoutTruncated = true
      stdout = append(stdout, text, maxBuffer)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk.toString('utf8'), maxBuffer)
    })
    child.on('error', (error) => {
      finish(() => resolve({
        exitCode: 1,
        stdout,
        stderr: errorMessage(error),
        stdoutTruncated,
      }))
    })
    child.on('close', (code, closeSignal) => {
      finish(() => resolve({
        exitCode: code ?? 1,
        stdout,
        stderr: closeSignal ? `killed by ${closeSignal}` : stderr,
        stdoutTruncated,
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

function runLocalShell(request: ShellRequest): Promise<ShellResult> {
  return runChild(
    () => spawn(request.command, {
      ...spawnOptions(request.cwd, 'pipe'),
      shell: true,
    }),
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
  return background(spawn(request.command, { ...spawnOptions(request.cwd, 'ignore'), shell: true }))
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

import { spawn, type ChildProcess } from 'node:child_process'

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

export interface HttpRequest {
  url: string
  headers?: Record<string, string>
  signal?: AbortSignal
  maxBytes?: number
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  truncated: boolean
}

/** Replaceable execution boundary used by builtin network/shell tools. */
export interface ExecutionProvider {
  runShell(request: ShellRequest): Promise<ShellResult>
  fetchHttp(request: HttpRequest): Promise<HttpResponse>
}

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

function runLocalShell(request: ShellRequest): Promise<ShellResult> {
  const timeoutMs = request.timeoutMs ?? 15_000
  const maxBuffer = request.maxBuffer ?? 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, {
      cwd: request.cwd,
      shell: true,
      windowsHide: true,
      ...(process.platform === 'win32' ? {} : { detached: true }),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let onAbort: () => void = () => {}
    const append = (target: string, chunk: Buffer, limit: number): string => {
      if (target.length >= limit) return target
      return target + chunk.toString('utf8').slice(0, limit - target.length)
    }
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
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
    onAbort = () => fail('shell command cancelled')
    if (request.signal) {
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => fail(`shell command timed out after ${timeoutMs}ms`), timeoutMs)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk, maxBuffer)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk, maxBuffer)
    })
    child.on('error', (error) => {
      finish(() => resolve({ exitCode: 1, stdout, stderr: errorMessage(error) }))
    })
    child.on('close', (code, closeSignal) => {
      finish(() => resolve({
        exitCode: code ?? 1,
        stdout,
        stderr: closeSignal ? `killed by ${closeSignal}` : stderr,
      }))
    })
  })
}

export const localExecutionProvider: ExecutionProvider = {
  runShell: runLocalShell,
  async fetchHttp(request) {
    const init: RequestInit = {}
    if (request.headers) init.headers = request.headers
    if (request.signal) init.signal = request.signal
    const response = await fetch(request.url, init)
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

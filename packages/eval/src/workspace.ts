import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveInside } from '@tnega/tools'

import type { EvalWorkspaceFixture, Task } from './types.js'

export interface TaskWorkspace {
  dir: string
  dispose(): Promise<void>
}

export interface WorkspaceCommandOptions {
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
}

export interface WorkspaceCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function createTaskWorkspace(
  task: Task,
  fixtureRoot?: string,
): Promise<TaskWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-eval-ws-'))
  const fixture: EvalWorkspaceFixture | undefined = fixtureRoot
    ? { root: fixtureRoot, ...(task.fixture?.files ? { files: task.fixture.files } : {}) }
    : task.fixture
  try {
    if (fixture?.root) {
      await cp(fixture.root, dir, { recursive: true, force: true })
    }
    for (const entry of fixture?.files ?? []) {
      const target = await resolveInside(dir, entry.path)
      await mkdir(dirname(target), { recursive: true })
      if (entry.content !== undefined) {
        await writeFile(target, entry.content, 'utf8')
      } else if (entry.from !== undefined) {
        const source = await resolveInside(dir, entry.from)
        await writeFile(target, await readFile(source), 'utf8')
      }
    }
    return {
      dir,
      dispose: () => rmRecursive(dir),
    }
  } catch (error) {
    await rmRecursive(dir)
    throw error
  }
}

export async function runWorkspaceCommand(
  cwd: string,
  command: string,
  options: WorkspaceCommandOptions = {},
): Promise<WorkspaceCommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBuffer = options.maxBuffer ?? 256 * 1024
  return runCommand(cwd, command, timeoutMs, maxBuffer, options.signal)
}

async function runCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
  maxBuffer: number,
  signal?: AbortSignal,
): Promise<WorkspaceCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      ...(process.platform === 'win32' ? {} : { detached: true }),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer: NodeJS.Timeout | undefined = setTimeout(() => {
      finish(() => {
        void kill().finally(() => resolve({ exitCode: 124, stdout, stderr: 'timed out' }))
      })
    }, timeoutMs)
    let onAbort: () => void = () => {}

    const append = (target: string, chunk: Buffer): string => {
      if (target.length >= maxBuffer) return target
      return target + chunk.toString('utf8').slice(0, maxBuffer - target.length)
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

    const kill = (): Promise<void> => killProcessTree(child)

    onAbort = () => {
      finish(() => {
        void kill().finally(() => resolve({ exitCode: 124, stdout, stderr: 'cancelled' }))
      })
    }

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error) => {
      finish(() => resolve({ exitCode: 1, stdout, stderr: error.message }))
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
      // Process group is already gone.
    }
    child.kill('SIGKILL')
  }
}

async function rmRecursive(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

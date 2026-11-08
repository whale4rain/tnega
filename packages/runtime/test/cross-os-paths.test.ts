import { win32 } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { FsService, workspacePath, type FsEntry, type FsStat, type WorkspaceFs } from '@tnega/fs'
import { announcedWorkspace } from '@tnega/fs-remote'
import type { DaemonLink } from '@tnega/daemon-protocol'
import type { ExecutionProvider, ShellRequest } from '@tnega/process'
import { tools, type ToolResult } from '@tnega/tools'
import { builtinTools } from '../src/builtins.js'

/**
 * A workspace on a Windows daemon while this runtime runs on any OS: the
 * paths that come back are `C:\Repo\…`, and the runtime must take them apart
 * by Windows rules, not by its own `node:path`.
 */
class WindowsWorkspace implements WorkspaceFs {
  readonly root = 'C:\\Repo'
  private readonly files = new Map<string, string>([['c:\\repo\\src\\a.ts', 'export const a = 1\n']])
  private readonly dirs = new Map<string, FsEntry[]>([
    ['c:\\repo', [{ name: 'src', kind: 'dir' }]],
    ['c:\\repo\\src', [{ name: 'a.ts', kind: 'file' }]],
  ])

  async realRoot(): Promise<string> { return this.root }

  async resolve(path: string): Promise<string> {
    const target = win32.resolve(this.root, path)
    const inside = win32.relative(this.root, target)
    if (inside.startsWith('..') || win32.isAbsolute(inside)) throw new Error(`${path} is outside the workspace`)
    return target
  }

  private key(path: string): string { return win32.resolve(this.root, path).toLowerCase() }

  async stat(path: string): Promise<FsStat | undefined> {
    const key = this.key(path)
    if (this.files.has(key)) return { kind: 'file', size: this.files.get(key)!.length, mtimeMs: 1, mode: 0 }
    if (this.dirs.has(key)) return { kind: 'dir', size: 0, mtimeMs: 1, mode: 0 }
    return undefined
  }

  async readFile(path: string): Promise<Uint8Array> {
    const text = this.files.get(this.key(path))
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return Buffer.from(text)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.files.set(this.key(path), typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
  }

  async list(path: string): Promise<FsEntry[]> { return this.dirs.get(this.key(path)) ?? [] }
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
}

class WindowsFs extends FsService {
  readonly workspaceFs = new WindowsWorkspace()
  override workspace(): WorkspaceFs { return this.workspaceFs }
}

async function mount() {
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin({ name: 'windows-fs', apply: (scope: Context) => { new WindowsFs(scope) } })
  const shells: ShellRequest[] = []
  const execution: ExecutionProvider = {
    async runShell(request) { shells.push(request); return { exitCode: 0, stdout: '', stderr: '' } },
    async runProcess() { throw new Error('not used') },
    async fetchHttp() { throw new Error('not used') },
  }
  await ctx.plugin(builtinTools, { cwd: 'C:\\Repo', allowShell: true, execution })
  const run = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
    const result: ToolResult = await ctx.get('tools').execute(name, input, {})
    if (!result.ok) throw new Error(`${name} failed: ${result.error?.message}`)
    return result.output as Record<string, unknown>
  }
  return { run, shells }
}

it('reads a workspace root by its own path rules', () => {
  expect(workspacePath('C:\\Repo')).toBe(win32)
  expect(workspacePath('\\\\server\\share')).toBe(win32)
  expect(workspacePath('/home/me/repo').sep).toBe('/')
})

it('shows paths on a Windows workspace relative to its root, with forward slashes', async () => {
  const { run } = await mount()
  expect(await run('read_file', { path: 'src\\a.ts' })).toMatchObject({ path: 'src/a.ts' })
  expect(await run('read_file', { path: 'src/a.ts' })).toMatchObject({ path: 'src/a.ts' })
  const listed = await run('list_dir', { path: '.', recursive: true })
  expect(listed).toEqual([
    { name: 'src', path: 'src', type: 'directory' },
    { name: 'a.ts', path: 'src/a.ts', type: 'file' },
  ])
})

it('runs a command in a Windows folder the workspace resolved, not one built by this machine', async () => {
  const { run, shells } = await mount()
  await run('shell', { command: 'dir', cwd: 'src' })
  expect(shells.at(-1)?.cwd).toBe('C:\\Repo\\src')
  await expect(run('shell', { command: 'dir', cwd: '..\\other' })).rejects.toThrow(/outside the workspace/)
})

it('finds a Windows daemon workspace however its root is spelled', () => {
  const link: DaemonLink = {
    deviceId: 'pc',
    protocolVersion: 1,
    capabilities: { platform: 'win32' },
    workspaces: [{ id: 'w1', path: 'C:\\Repo' }],
    closed: false,
    call: async () => { throw new Error('not used') },
    onNotification: () => () => {},
    onClose: () => () => {},
    close: () => {},
  }
  expect(announcedWorkspace(link, 'C:\\Repo').id).toBe('w1')
  expect(announcedWorkspace(link, 'c:/repo/').id).toBe('w1')
  expect(() => announcedWorkspace(link, 'C:\\Other')).toThrow(/does not serve/)
  // A relative root is not read against this process's folder.
  expect(() => announcedWorkspace(link, 'Repo')).toThrow(/does not serve/)
})

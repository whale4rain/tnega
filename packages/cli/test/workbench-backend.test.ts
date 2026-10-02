import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { fileDiff, listChanges, parsePorcelain } from '../src/changes.js'
import { TerminalManager, type PtyLike, type TerminalEvent } from '../src/terminals.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

class FakePty implements PtyLike {
  written: string[] = []
  size: [number, number] = [0, 0]
  killed = false
  private data: Array<(data: string) => void> = []
  private exit: Array<(event: { exitCode: number }) => void> = []
  onData(listener: (data: string) => void) { this.data.push(listener) }
  onExit(listener: (event: { exitCode: number }) => void) { this.exit.push(listener) }
  write(data: string) { this.written.push(data) }
  resize(cols: number, rows: number) { this.size = [cols, rows] }
  kill() { this.killed = true }
  emit(data: string) { for (const listener of this.data) listener(data) }
  end(code: number) { for (const listener of this.exit) listener({ exitCode: code }) }
}

describe('workbench terminals', () => {
  it('replays scrollback to a late subscriber, forwards input, resizes and closes', async () => {
    const ptys: FakePty[] = []
    const manager = new TerminalManager({
      shell: { shell: 'fake-sh', args: [] },
      spawn: (_shell, _args, options) => {
        const pty = new FakePty()
        pty.size = [options.cols, options.rows]
        ptys.push(pty)
        return pty
      },
    })
    const info = await manager.create('/work', { cols: 1000, rows: 2 })
    expect(info).toMatchObject({ title: 'fake-sh', cols: 500, rows: 5 })
    const pty = ptys[0]!
    pty.emit('hello ')
    pty.emit('world')

    const seen: TerminalEvent[] = []
    const detach = manager.attach(info.id, event => seen.push(event))
    expect(seen).toEqual([{ type: 'data', data: 'hello world' }])
    pty.emit('!')
    manager.write(info.id, 'ls\r')
    manager.resize(info.id, 120, 40)
    expect(pty.written).toEqual(['ls\r'])
    expect(pty.size).toEqual([120, 40])
    pty.end(0)
    expect(seen.at(-2)).toEqual({ type: 'data', data: '!' })
    expect(seen.at(-1)).toEqual({ type: 'exit', code: 0 })
    detach()

    expect(manager.list()).toHaveLength(1)
    manager.close(info.id)
    expect(manager.list()).toHaveLength(0)
    expect(() => manager.write(info.id, 'x')).toThrow(/not found/)
  })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('workbench changes', () => {
  it('parses renames in porcelain output', () => {
    expect(parsePorcelain('R  new.ts\0old.ts\0 M a.ts\0?? b.ts\0')).toEqual([
      { code: 'R ', path: 'new.ts', previousPath: 'old.ts' },
      { code: ' M', path: 'a.ts' },
      { code: '??', path: 'b.ts' },
    ])
  })

  it('lists changes below a workspace inside a repository and returns both sides of a diff', async () => {
    const repo = await tempDir('tnega-changes-')
    const workspace = join(repo, 'app')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(repo, 'outside.txt'), 'outside\n')
    await writeFile(join(workspace, 'src', 'a.ts'), 'one\ntwo\n')
    await writeFile(join(workspace, 'gone.txt'), 'bye\n')
    git(repo, 'init', '-q')
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

    await writeFile(join(workspace, 'src', 'a.ts'), 'one\n2\nthree\n')
    await rm(join(workspace, 'gone.txt'))
    await writeFile(join(workspace, 'new.md'), '# new\nline\n')
    await writeFile(join(repo, 'outside.txt'), 'changed outside the workspace\n')

    const summary = await listChanges(workspace)
    expect(summary.git).toBe(true)
    expect(summary.files).toEqual([
      { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'new.md', status: 'untracked', additions: 2, deletions: 0 },
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
    ])

    expect(await fileDiff(workspace, 'src/a.ts')).toEqual({ path: 'src/a.ts', status: 'modified', original: 'one\ntwo\n', modified: 'one\n2\nthree\n' })
    expect(await fileDiff(workspace, 'new.md')).toMatchObject({ original: null, modified: '# new\nline\n' })
    expect(await fileDiff(workspace, 'gone.txt')).toMatchObject({ original: 'bye\n', modified: null })
  })

  it('reports a workspace outside git', async () => {
    expect(await listChanges(await tempDir('tnega-nogit-'))).toEqual({ git: false, files: [] })
  })
})

describe('terminal over the web server', () => {
  it('runs a real shell command through the API', async () => {
    const { startWebServer } = await import('../src/server.js')
    const dir = await tempDir('tnega-term-')
    const server = await startWebServer({ port: 0, browser: false, configFile: join(dir, 'config.json') })
    const headers = { 'x-tnega-client': '1', 'content-type': 'application/json' }
    try {
      const created = await fetch(`${server.url}/api/terminals?workspace=${encodeURIComponent(dir)}`, { method: 'POST', headers, body: '{"cols":80,"rows":24}' })
      if (created.status === 501) return // No PTY binary for this platform.
      const { id } = await created.json() as { id: string }
      const controller = new AbortController()
      const stream = await fetch(`${server.url}/api/terminals/${id}/stream`, { headers, signal: controller.signal })
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      const marker = new Promise<void>((resolveMarker, rejectMarker) => {
        const timeout = setTimeout(() => rejectMarker(new Error(`no marker in: ${text.slice(-400)}`)), 20_000)
        const pump = async () => {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) return
            text += decoder.decode(value)
            // The stream is JSON, so escape sequences arrive as literal `\u001b[…` text.
            if (/tnega-pty-42/.test(text.replace(/\\u001b\[[0-9;?]*[A-Za-z]/g, ''))) {
              clearTimeout(timeout)
              resolveMarker()
              return
            }
          }
        }
        void pump()
      })
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
      await fetch(`${server.url}/api/terminals/${id}/input`, { method: 'POST', headers, body: JSON.stringify({ data: 'echo tnega-pty-$((6*7))\r' }) })
      await marker
      controller.abort()
      expect((await fetch(`${server.url}/api/terminals/${id}`, { method: 'DELETE', headers })).status).toBe(200)
    } finally {
      await server.close()
    }
  }, 40_000)
})

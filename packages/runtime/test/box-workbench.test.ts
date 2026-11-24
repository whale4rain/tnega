import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { startDaemon } from '@tnega/daemon'
import { acceptDaemon, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { fsLocal } from '@tnega/fs-local'
import { resolveRipgrepPath } from '@tnega/search-ripgrep'
import { webServer } from '@tnega/web-kit'
import { FileServeError, fileRoutes, type FileRoutesConfig } from '@tnega/workspace-files'
import { boxWorkbench } from '../src/machines.js'

const run = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-box-workbench-'))
  // Windows can keep a just-exited git's cwd busy for a moment.
  cleanups.push(async () => {
    for (let attempt = 0; ; attempt++) {
      try { await rm(dir, { recursive: true, force: true }); return } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  })
  return dir
}

async function box(workspace: string): Promise<DaemonLink> {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({ connect: () => daemonSide, workspaces: [{ path: workspace }], reconnect: false, heartbeat: false, terminals: false })
  const link = await accepted
  await daemon.ready
  cleanups.push(async () => { await daemon.close(); link.close() })
  return link
}

async function serve(config: FileRoutesConfig): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(webServer)
  await ctx.plugin(fsLocal)
  await ctx.plugin(fileRoutes, config)
  const web = ctx.get('webServer')
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = web.match(req.method ?? 'GET', url.pathname)
    if (match.kind === 'route') void match.handler(req, res, url)
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise<void>(done => server.close(() => done())))
  cleanups.push(() => ctx.fiber.dispose().then(() => undefined))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

it('shows the files, changes and file search of a box that keeps its own volume', async () => {
  const inBox = await tempDir()
  const onHost = await tempDir()
  const git = (...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: inBox })
  await git('init', '-q')
  await writeFile(join(inBox, 'a.txt'), 'one\n')
  await git('add', '.')
  await git('commit', '-qm', 'first')
  await writeFile(join(inBox, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(inBox, 'new.md'), '# new\n')
  await writeFile(join(onHost, 'host-only.txt'), 'not in the box\n')

  const link = await box(inBox)
  let released = 0
  const ripgrep = await resolveRipgrepPath()
  const base = await serve({
    machine: async workspace => {
      if (workspace !== onHost) return undefined
      // The pool's lease, as the server takes it: the box's daemon announces the workspace at its own path.
      const view = boxWorkbench({ machineId: 'm1', deviceId: 'd1', link, workspacePath: inBox, release: () => { released++ } })
      return { ...view, ripgrep }
    },
  })
  const query = (path: string, extra = '') => fetch(`${base}${path}?workspace=${encodeURIComponent(onHost)}${extra}`)

  const tree = await (await query('/api/files/tree')).json() as { entries: Array<{ name: string }> }
  const names = tree.entries.map(entry => entry.name)
  expect(names).toEqual(expect.arrayContaining(['a.txt', 'new.md']))
  expect(names).not.toContain('host-only.txt')
  expect(await (await query('/api/files/text', '&path=a.txt')).json()).toMatchObject({ content: 'one\ntwo\n' })

  const changes = await (await query('/api/changes')).json() as { git: boolean; files: Array<{ path: string; status: string }> }
  expect(changes.git).toBe(true)
  expect(changes.files.map(file => [file.path, file.status])).toEqual([['a.txt', 'modified'], ['new.md', 'untracked']])
  expect(await (await query('/api/changes/file', '&path=a.txt')).json()).toMatchObject({ original: 'one\n', modified: 'one\ntwo\n' })

  expect(await (await query('/api/files/search', '&q=new')).json()).toEqual({ files: ['new.md'] })
  // Every request let go of its lease.
  expect(released).toBe(5)
})

it('answers with the resolver\'s error when the box sleeps', async () => {
  const onHost = await tempDir()
  const base = await serve({ machine: async () => { throw new FileServeError('your box for this folder is not running', 409) } })
  for (const path of ['/api/files/tree', '/api/changes', '/api/files/search']) {
    const response = await fetch(`${base}${path}?workspace=${encodeURIComponent(onHost)}`)
    expect(response.status).toBe(409)
  }
})

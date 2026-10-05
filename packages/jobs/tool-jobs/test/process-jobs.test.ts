import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@tnega/core'
import { builtinTools, localUrls, ProcessRegistry, stripAnsi, tools, type ExecutionProvider, type ToolsService } from '@tnega/tools'
import { jobsLocal } from '../../jobs-local/src/index.js'
import { toolJobs } from '../src/index.js'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function setup(options: { processes?: ProcessRegistry; execution?: ExecutionProvider } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-process-job-'))
  dirs.push(cwd)
  const root = new Context()
  await root.plugin(tools)
  const builtins = await root.plugin(builtinTools, { cwd, allowShell: true, ...options })
  const jobs = await root.plugin(jobsLocal)
  await root.plugin(toolJobs)
  const registry: ToolsService = root.get('tools')
  return { root, cwd, registry, builtins, jobs }
}

type ProcessJob = { job_id: string; status: string; process_id?: string; urls: string[]; output: string; note?: string; hint?: string; detail?: string }

describe('localUrls', () => {
  it('finds dev server URLs through colour codes and rewrites 0.0.0.0', () => {
    const vite = '\u001b[32m  ➜  Local:\u001b[39m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  ➜  Network: http://0.0.0.0:5173/'
    expect(stripAnsi(vite)).toContain('http://localhost:5173/')
    expect(localUrls(vite)).toEqual(['http://localhost:5173/'])
    expect(localUrls('ready on http://127.0.0.1:3000.')).toEqual(['http://127.0.0.1:3000'])
    expect(localUrls('see https://example.com')).toEqual([])
  })
})

describe('shell as a background job', () => {
  it('starts a server, reports its URL, reads only new output, and stops it with job_kill', async () => {
    const { root, cwd, registry } = await setup()
    // A script file keeps the command free of quoting that differs between shells.
    await writeFile(join(cwd, 'server.cjs'), 'console.log("ready at http://localhost:4321/"); setInterval(() => console.log("tick"), 100)')
    expect(registry.list().some(tool => tool.schema.name.startsWith('process_'))).toBe(false)

    const started = await registry.execute('job_start', { tool: 'shell', input: { command: 'node server.cjs' }, wait_for_url_ms: 10_000 })
    expect(started.ok).toBe(true)
    const job = started.output as ProcessJob
    expect(job).toMatchObject({ status: 'running', process_id: 'p1', urls: ['http://localhost:4321/'] })
    expect(job.output).toContain('ready at')
    expect(root.jobs.list()).toMatchObject([{ id: job.job_id, label: 'node server.cjs', processId: 'p1', urls: ['http://localhost:4321/'] }])

    await new Promise(resolve => setTimeout(resolve, 350))
    const more = (await registry.execute('job_output', { job_id: job.job_id })).output as ProcessJob
    expect(more.output).toContain('tick')
    expect(more.output).not.toContain('ready at')
    const all = (await registry.execute('job_output', { job_id: job.job_id, all: true })).output as ProcessJob
    expect(all.output).toContain('ready at')

    await registry.execute('job_kill', { job_id: job.job_id })
    const stopped = await root.jobs.wait(job.job_id, 10_000)
    expect(stopped.status).toBe('killed')
    const final = (await registry.execute('job_output', { job_id: job.job_id })).output as ProcessJob
    expect(final).toMatchObject({ status: 'killed', urls: ['http://localhost:4321/'] })
  }, 30_000)

  it('finishes with the exit code and output of a command that ends', async () => {
    const { root, registry } = await setup()
    const started = (await registry.execute('job_start', { tool: 'shell', input: { command: 'node -e "console.log(41 + 1); process.exit(3)"' } })).output as ProcessJob
    const done = await root.jobs.wait(started.job_id, 10_000)
    expect(done).toMatchObject({ status: 'failed', detail: 'exit code 3' })
    const read = (await registry.execute('job_output', { job_id: started.job_id })).output as ProcessJob
    expect(read.output).toContain('42')
  }, 30_000)

  it('keeps a server in a shared workspace registry when the runtime goes away, and kills private ones', async () => {
    const shared = new ProcessRegistry()
    const first = await setup({ processes: shared })
    await first.registry.execute('job_start', { tool: 'shell', input: { command: 'node -e "setInterval(() => {}, 1000)"' } })
    await first.jobs.dispose()
    await first.builtins.dispose()
    expect(shared.list()).toMatchObject([{ id: 'p1', status: 'running' }])
    await shared.dispose()
    expect(shared.running()).toHaveLength(0)

    let kills = 0
    let exit: (code: number | null) => void = () => undefined
    const exited = new Promise<number | null>(resolve => { exit = resolve })
    const fake: ExecutionProvider = {
      runShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false }),
      fetchHttp: async () => ({ status: 200, ok: true, headers: {}, body: '', truncated: false }),
      startShell: async () => ({
        pid: 1, output: () => 'watching', exitCode: () => kills ? null : undefined, exited,
        kill: async () => { kills += 1; exit(null) },
      }),
    }
    const owned = await setup({ execution: fake })
    const started = (await owned.registry.execute('job_start', { tool: 'shell', input: { command: 'npm run watch' } })).output as ProcessJob
    expect(started.status).toBe('running')
    await owned.jobs.dispose()
    expect(kills).toBe(1)
  }, 30_000)

  it('reports a denied start as a failed job instead of hanging', async () => {
    const { root, registry } = await setup()
    registry.guard(request => request.name === 'shell' ? 'shell was not approved' : undefined)
    const started = await registry.execute('job_start', { tool: 'shell', input: { command: 'npm run dev' } })
    expect(started.ok).toBe(true)
    const [job] = root.jobs.list()
    const done = await root.jobs.wait(job!.id, 5_000)
    expect(done.status).toBe('failed')
    expect(root.jobs.read(job!.id).output).toContain('shell was not approved')
  })

  it.runIf(process.platform === 'win32')('warns that a confined server can fail later, and points at escalation once it does', async () => {
    let output = 'VITE ready\n  Local: http://localhost:5199/\n'
    const requests: Array<{ unsandboxed?: boolean }> = []
    const fake: ExecutionProvider = {
      runShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false }),
      fetchHttp: async () => ({ status: 200, ok: true, headers: {}, body: '', truncated: false }),
      startShell: async request => {
        requests.push(request)
        return {
          pid: 1, sandboxed: request.unsandboxed !== true, output: () => output, exitCode: () => undefined,
          exited: new Promise<number | null>(() => {}), kill: async () => {},
        }
      },
    }
    const { registry } = await setup({ execution: fake })
    const started = (await registry.execute('job_start', { tool: 'shell', input: { command: 'npm run dev' } })).output as ProcessJob
    expect(started.note).toMatch(/spawn EPERM/)

    output += '[vite] Internal server error: spawn EPERM\n'
    const read = (await registry.execute('job_output', { job_id: started.job_id })).output as ProcessJob
    expect(read.hint).toMatch(/escalate: true/)
    expect(requests.map(request => request.unsandboxed === true)).toEqual([false])
  })
})

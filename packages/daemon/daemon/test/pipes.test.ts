import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { acceptDaemon, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { remotePipes } from '@tnega/process-remote'
import { startDaemon } from '../src/index.js'

const dirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  // Windows can keep a just-killed child's cwd busy for a moment.
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try { await rm(dir, { recursive: true, force: true }); break } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-daemon-pipes-'))
  dirs.push(dir)
  return dir
}

async function daemonFor(workspace: string, pipes: boolean): Promise<DaemonLink> {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({ connect: () => daemonSide, workspaces: [{ path: workspace }], reconnect: false, heartbeat: false, terminals: false, pipes })
  const link = await accepted
  await daemon.ready
  cleanups.push(async () => { await daemon.close(); link.close() })
  return link
}

/** Echoes each stdin line back upper-cased, says hello on stderr, exits on "bye". */
const ECHO = `
process.stderr.write('hello\\n')
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  let index
  while ((index = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    if (line === 'bye') process.exit(7)
    process.stdout.write(line.toUpperCase() + '\\n')
  }
})
`

it('serves no stdio processes unless the daemon was told to', async () => {
  const link = await daemonFor(await tempDir(), false)
  expect(link.capabilities.services ?? []).not.toContain('pipes')
  expect(remotePipes(link)).toBeUndefined()
})

it('runs a process over stdin and stdout, in order, and reports its exit', async () => {
  const dir = await tempDir()
  const link = await daemonFor(dir, true)
  const launch = remotePipes(link)
  if (!launch) throw new Error('expected pipes')
  let stdout = ''
  let stderr = ''
  let exit: string | undefined
  const piped = await launch({ argv: [process.execPath, '-e', ECHO], cwd: dir }, {
    onStdout: data => { stdout += data },
    onStderr: data => { stderr += data },
    onExit: reason => { exit = reason },
  })
  await piped.write('one\n')
  await piped.write('two\n')
  await expect.poll(() => stdout).toBe('ONE\nTWO\n')
  // Output written before anyone followed is not lost.
  await expect.poll(() => stderr).toBe('hello\n')
  await piped.write('bye\n')
  await expect.poll(() => exit).toBe('exited with 7')
})

it('kills the process when the runtime closes it, without calling it an exit', async () => {
  const dir = await tempDir()
  const link = await daemonFor(dir, true)
  const launch = remotePipes(link)
  if (!launch) throw new Error('expected pipes')
  let stdout = ''
  let exited = false
  const piped = await launch({ argv: [process.execPath, '-e', `${ECHO}\nprocess.stdout.write(String(process.pid) + '\\n')`], cwd: dir }, {
    onStdout: data => { stdout += data },
    onExit: () => { exited = true },
  })
  await expect.poll(() => stdout).toMatch(/^\d+\n$/)
  const pid = Number(stdout.trim())
  await piped.close()
  await expect.poll(() => {
    try { process.kill(pid, 0); return true } catch { return false }
  }).toBe(false)
  expect(exited).toBe(false)
})

it('starts processes only inside a workspace it serves, and says when a program is missing', async () => {
  const dir = await tempDir()
  const other = await tempDir()
  const link = await daemonFor(dir, true)
  const launch = remotePipes(link)
  if (!launch) throw new Error('expected pipes')
  await expect(launch({ argv: [process.execPath, '-e', ''], cwd: other }, { onStdout: () => undefined })).rejects.toThrow(/not inside a workspace/)
  await expect(launch({ argv: ['tnega-no-such-program'], cwd: dir }, { onStdout: () => undefined })).rejects.toThrow(/could not start tnega-no-such-program/)
})

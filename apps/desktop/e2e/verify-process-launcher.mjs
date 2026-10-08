/* Local Windows integration check; run with Electron, outside CI. */
import { app, utilityProcess } from 'electron'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers'

app.whenReady().then(async () => {
  if (process.platform !== 'win32') throw new Error('Windows integration check')
  const repository = resolve(import.meta.dirname, '../../..')
  const artifacts = join(import.meta.dirname, '.artifacts')
  await mkdir(artifacts, { recursive: true })
  const scratch = await mkdtemp(join(artifacts, 'process-launcher-'))
  const nodeExecutable = execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
  let restore
  try {
    const modulePath = join(scratch, 'launcher.mjs')
    await build({
      stdin: {
        contents: 'export { configureProcessLauncher, localExecutionProvider } from "./packages/execution/src/index.ts"; export { desktopProcessLauncher } from "./apps/desktop/src/process-launcher.ts";',
        resolveDir: repository, sourcefile: 'verify-launcher.ts', loader: 'ts',
      },
      outfile: modulePath, bundle: true, platform: 'node', format: 'esm',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    })
    const execution = await import(pathToFileURL(modulePath).href)
    restore = execution.configureProcessLauncher(execution.desktopProcessLauncher(utilityProcess.fork, process.execPath))
    const worker = join(scratch, 'worker.mjs')
    await writeFile(worker, `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env.TNEGA_WORKER_TEST, cwd: process.cwd(), bootstrap: process.env.ELECTRON_RUN_AS_NODE }));
process.stderr.write('stderr');
process.exit(7);
`)
    const result = await execution.localExecutionProvider.runProcess({
      argv: [process.execPath, worker, 'one topic', '& literal'], cwd: scratch,
      env: { ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1', TNEGA_WORKER_TEST: 'worker' }, timeoutMs: 10_000,
    })
    assert.equal(result.exitCode, 7)
    assert.equal(result.stderr, 'stderr')
    const data = JSON.parse(result.stdout)
    assert.deepEqual(data.argv, ['one topic', '& literal'])
    assert.equal(data.env, 'worker')
    assert.equal(data.cwd, scratch)
    assert.equal(data.bootstrap, undefined)
    console.log('PASS native utility argv / environment / streams / exit')
    await writeFile(worker, `
import { writeSync } from 'node:fs';
writeSync(1, 'x'.repeat(256 * 1024) + 'stdout-tail');
writeSync(2, 'y'.repeat(256 * 1024) + 'stderr-tail');
process.exit(3);
`)
    const large = await execution.localExecutionProvider.runProcess({
      argv: [process.execPath, worker], cwd: scratch, env: { ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' }, timeoutMs: 10_000,
    })
    assert.equal(large.exitCode, 3)
    assert.equal(large.stdout, 'x'.repeat(256 * 1024) + 'stdout-tail')
    assert.equal(large.stderr, 'y'.repeat(256 * 1024) + 'stderr-tail')
    console.log('PASS 256 KB per stream with same-tick exit / output tails / backpressure')

    const runner = join(scratch, 'runner.mjs')
    await build({
      entryPoints: [join(repository, 'packages/sandbox/sandbox-windows-acl/src/runner.ts')],
      outfile: runner, bundle: true, platform: 'node', format: 'esm', external: ['koffi'],
    })
    const workspace = join(scratch, 'workspace')
    await mkdir(workspace)
    const confined = await execution.localExecutionProvider.runProcess({
      argv: [process.execPath, runner, '--workspace', workspace, '--temp', scratch, '--mode', 'read-only', '--', 'cmd.exe', '/d', '/s', '/c', 'echo confined'],
      cwd: workspace, env: { ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' }, timeoutMs: 10_000,
    })
    assert.equal(confined.exitCode, 0, confined.stderr)
    assert.equal(confined.stdout.trim(), 'confined')
    console.log('PASS native restricted runner / inherited stdin and output / cmd')
    const eof = await execution.localExecutionProvider.runProcess({
      argv: [process.execPath, runner, '--workspace', workspace, '--temp', scratch, '--mode', 'read-only', '--', nodeExecutable, '-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"))'],
      cwd: workspace, env: { ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' }, timeoutMs: 10_000,
    })
    assert.equal(eof.exitCode, 0, eof.stderr)
    assert.equal(eof.stdout.trim(), 'eof')
    console.log('PASS restricted stdin reads immediate EOF')
    await writeFile(worker, `import { spawn } from 'node:child_process'; const child = spawn(${JSON.stringify(nodeExecutable)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); process.stdout.write(String(child.pid)); setInterval(() => {}, 1000);`)
    const background = await execution.localExecutionProvider.startProcess({
      argv: [process.execPath, worker], cwd: scratch, env: { ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' },
    })
    const deadline = Date.now() + 10_000
    while (!background.output() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    const grandchild = Number(background.output())
    assert.ok(grandchild > 0)
    await background.kill()
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/)
    console.log('PASS background PID / cancellation / complete descendant cleanup')
    await writeFile(worker, 'setInterval(() => {}, 1000)')
    await assert.rejects(execution.localExecutionProvider.runProcess({
      argv: [process.execPath, worker], cwd: scratch, env: { ELECTRON_RUN_AS_NODE: '1', TNEGA_DESKTOP_ACL_RUNNER: '1' }, timeoutMs: 5,
    }), /timed out/)
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(app.getAppMetrics().filter(metric => metric.name === 'Tnega Agent Worker').length, 0)
    console.log('PASS cancellation before utility spawn / no live worker')
  } finally {
    restore?.()
    await rm(scratch, { recursive: true, force: true })
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1) })

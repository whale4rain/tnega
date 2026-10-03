import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { resolveRunnerCommand } from '../../../packages/sandbox/sandbox-windows-acl/src/runner-command.js'

test('desktop build ships an executable ACL runner beside the main bundle', () => {
  const desktop = resolve('apps/desktop')
  const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: desktop, encoding: 'utf8' })
  expect(built.status, built.stderr).toBe(0)
  const command = resolveRunnerCommand({ moduleUrl: pathToFileURL(resolve(desktop, 'out/main.js')) })
  expect(command[1]).toBe(resolve(desktop, 'out/sandbox-windows-acl-runner.js'))
  const result = spawnSync(command[0]!, [...command.slice(1)], { encoding: 'utf8', windowsHide: true })
  expect(result.status).toBe(127)
  expect(result.stderr).toContain('windows-acl-run:')
  expect(result.stderr).not.toContain('Cannot find module')
}, 30_000)

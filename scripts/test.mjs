import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

/**
 * `pnpm test` entry point. It exists to keep two kinds of test apart:
 *
 * - the **code layer** (default): deterministic, needs nothing but the checkout.
 * - the **host layer** (`--全量` / `--all`, or `--host` alone): needs a real
 *   build, a provider key, Chromium/Electron or Windows ACL privileges. See
 *   `vitest.layers.ts`.
 *
 * `--全量` runs the code layer and the host layer in two passes rather than one:
 * the host layer's full build and GUI tests starve under the parallel load of
 * ~280 files, which is exactly how they come back red for no code reason.
 */

const FULL = new Set(['--全量', '--all'])
const HOST_ONLY = new Set(['--host'])

const argv = process.argv.slice(2)
const full = argv.some(argument => FULL.has(argument))
const hostOnly = argv.some(argument => HOST_ONLY.has(argument))
const filters = argv.filter(argument => !FULL.has(argument) && !HOST_ONLY.has(argument))

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))

function run(config, extra) {
  const result = spawnSync(process.execPath, [vitest, 'run', '--config', config, ...extra], { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

if (hostOnly) {
  process.exit(run('vitest.host.config.ts', filters))
}

if (!full) {
  // A filter is a code-layer path: keep the default, fast layer.
  process.exit(run('vitest.config.ts', filters))
}

if (filters.length) {
  // A filtered 全量 pass names files, so it stays one run; the caller picked
  // the files and does not want the whole host layer on top of them.
  process.exit(run('vitest.full.config.ts', filters))
}

const code = run('vitest.config.ts', [])
if (code !== 0) process.exit(code)
process.exit(run('vitest.host.config.ts', []))

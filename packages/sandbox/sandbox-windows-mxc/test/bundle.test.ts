/**
 * The package entry re-exports the runner's pure functions, so a bundler pulls
 * the runner into whatever imports the package (the CLI's `bin.js`, the
 * desktop `main.js`). The runner must start only as its own file.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('does not start the runner when bundled into another entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tnega-mxc-bundle-'))
  try {
    const outfile = join(dir, 'bin.js')
    await build({
      stdin: {
        contents: `import { containerIdFor } from ${JSON.stringify(fileURLToPath(new URL('../src/index.ts', import.meta.url)))}\nconsole.log(containerIdFor('/w'))`,
        resolveDir: dir,
        loader: 'ts',
      },
      bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    })
    const result = spawnSync(process.execPath, [outfile, 'web'], { encoding: 'utf8' })
    expect(result.stderr).not.toContain('mxc-sandbox-run')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^tnega-[0-9a-f]{24}\n$/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

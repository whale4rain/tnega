import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const packaging = spawnSync(pnpm, ['--filter', '@tnega/desktop', 'package'], {
  cwd: root,
  stdio: 'inherit',
})

if (packaging.status !== 0) {
  process.exit(packaging.status ?? 1)
}

const release = resolve(root, 'apps/desktop/release')
const installers = (await readdir(release, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.exe'))
  .map((entry) => resolve(release, entry.name))

if (installers.length !== 1) {
  throw new Error(`expected one Windows installer in ${release}`)
}

console.log(`Windows installer: ${installers[0]}`)

import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const packaging = spawnSync('pnpm', ['--filter', '@tnega/desktop', 'package'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (packaging.status !== 0) {
  process.exit(packaging.status ?? 1)
}

const release = resolve(root, 'apps/desktop/release')
const desktopPackage = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'))
const expectedName = `Tnega Setup ${desktopPackage.version}.exe`
const installers = (await readdir(release, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name === expectedName)
  .map((entry) => resolve(release, entry.name))

if (installers.length !== 1) {
  throw new Error(`expected ${expectedName} in ${release}`)
}

console.log(`Windows installer: ${installers[0]}`)

// Release helper. The full runbook is docs/releases/publishing.md.
//
//   node scripts/release.mjs version 0.4.6   bump the root and desktop versions together
//   node scripts/release.mjs check           verify the tree is ready to publish
//   node scripts/release.mjs desktop         build the installer and publish it with the update feed
//   node scripts/release.mjs feed            write latest.yml for an installer built without publishing
//   node scripts/release.mjs verify          check the published release has a working update feed
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const rootPackage = resolve(root, 'package.json')
const desktopPackage = resolve(root, 'apps/desktop/package.json')

const REPO = 'whale4rain/tnega'
const releaseDir = resolve(root, 'apps/desktop/release')

/** The installer name on disk and on GitHub (electron-builder.yml `nsis.artifactName`). */
function installerName(version) {
  return `Tnega-Setup-${version}.exe`
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeVersion(file, version) {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
  if (next === text) throw new Error(`no version field in ${file}`)
  writeFileSync(file, next)
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/** Problems that would publish the wrong thing; an empty list means ready. */
function problems() {
  const found = []
  const version = readJson(rootPackage).version
  const desktop = readJson(desktopPackage).version
  if (version !== desktop) found.push(`package.json is ${version} but apps/desktop/package.json is ${desktop}`)
  if (!existsSync(resolve(root, `docs/releases/v${version}.md`))) found.push(`docs/releases/v${version}.md is missing`)
  const branch = capture('git', ['branch', '--show-current'])
  if (branch !== 'main') found.push(`releases are cut from main (on ${branch ?? 'unknown'})`)
  if (capture('git', ['status', '--porcelain'])) found.push('the working tree has uncommitted changes')
  const tag = capture('git', ['tag', '--points-at', 'HEAD'])
  if (!tag?.split(/\s+/).includes(`v${version}`)) found.push(`HEAD is not tagged v${version}`)
  return { version, found }
}

const [command, argument] = process.argv.slice(2)

if (command === 'version') {
  if (!argument || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(argument)) fail('usage: release.mjs version <x.y.z>')
  writeVersion(rootPackage, argument)
  writeVersion(desktopPackage, argument)
  const notes = resolve(root, `docs/releases/v${argument}.md`)
  if (!existsSync(notes)) {
    writeFileSync(notes, `# Tnega v${argument}\n\n- \n\n## Install\n\n\`\`\`bash\nnpm install -g tnega@${argument}\n\`\`\`\n\nWindows: download **Tnega-Setup-${argument}.exe** from this release, or let an installed client update itself (Settings → Check for updates).\n`)
  }
  console.log(`version ${argument}; write the notes in docs/releases/v${argument}.md`)
} else if (command === 'check') {
  const { version, found } = problems()
  if (found.length) fail(`v${version} is not ready:\n  - ${found.join('\n  - ')}`)
  console.log(`v${version} is ready to publish`)
} else if (command === 'desktop') {
  const { version, found } = problems()
  if (found.length) fail(`v${version} is not ready:\n  - ${found.join('\n  - ')}`)
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) fail('set GH_TOKEN to a GitHub token that can write releases on whale4rain/tnega')
  // electron-builder uploads the installer, its blockmap and latest.yml (the
  // update feed) to the v<version> release, creating it if needed.
  run('pnpm', ['--filter', '@tnega/desktop', 'package', '--publish', 'always',
    `-c.releaseInfo.releaseNotesFile=../../docs/releases/v${version}.md`], {
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  })
  console.log(`published ${installerName(version)} and latest.yml to https://github.com/${REPO}/releases/tag/v${version}`)
  run(process.execPath, [resolve(root, 'scripts/release.mjs'), 'verify', version])
} else if (command === 'feed') {
  // electron-builder writes latest.yml only while publishing. For an installer
  // built with `pnpm package:desktop` (or already uploaded by hand), write the
  // same file from the installer itself, so clients can find and verify it.
  const version = readJson(desktopPackage).version
  const name = installerName(version)
  const legacy = resolve(releaseDir, `Tnega Setup ${version}.exe`)
  const installer = existsSync(resolve(releaseDir, name)) ? resolve(releaseDir, name) : legacy
  if (!existsSync(installer)) fail(`no installer for ${version} in ${releaseDir}`)
  const bytes = readFileSync(installer)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const size = statSync(installer).size
  writeFileSync(resolve(releaseDir, 'latest.yml'), [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n'))
  if (existsSync(`${installer}.blockmap`) && installer !== resolve(releaseDir, name)) {
    copyFileSync(`${installer}.blockmap`, resolve(releaseDir, `${name}.blockmap`))
  }
  console.log(`wrote ${resolve(releaseDir, 'latest.yml')} for ${name} (${size} bytes)`)
  console.log(`upload it beside the installer: gh release upload v${version} "${resolve(releaseDir, 'latest.yml')}" "${resolve(releaseDir, `${name}.blockmap`)}" -R ${REPO} --clobber`)
} else if (command === 'verify') {
  const version = argument ?? readJson(desktopPackage).version
  const base = `https://github.com/${REPO}/releases`
  const feed = await fetch(`${base}/download/v${version}/latest.yml`)
  if (!feed.ok) fail(`v${version} has no latest.yml (${feed.status}); clients cannot update. Run \`pnpm release feed\` and upload it.`)
  const text = await feed.text()
  const url = /^path: (.+)$/m.exec(text)?.[1]?.trim()
  const declared = Number(/^\s+size: (\d+)$/m.exec(text)?.[1])
  if (!text.includes(`version: ${version}`) || !url) fail(`latest.yml on v${version} does not describe ${version}:\n${text}`)
  const asset = await fetch(`${base}/download/v${version}/${url}`, { method: 'HEAD', redirect: 'follow' })
  if (!asset.ok) fail(`latest.yml points at ${url}, which is not on the release (${asset.status})`)
  const size = Number(asset.headers.get('content-length'))
  if (size && declared && size !== declared) fail(`${url} is ${size} bytes but latest.yml says ${declared}`)
  const latest = await fetch(`${base}/latest`, { redirect: 'manual' })
  const location = latest.headers.get('location') ?? ''
  if (!location.endsWith(`/v${version}`)) console.warn(`note: the latest release is ${location || 'unknown'}, not v${version}`)
  console.log(`v${version}: latest.yml → ${url} (${declared} bytes) is published and downloadable`)
} else {
  fail('usage: release.mjs <version x.y.z | check | desktop | feed | verify [x.y.z]>')
}

// Read-only gates and fixed artifact preparation for the tag release workflow.
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, relative, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import process from 'node:process'
import console from 'node:console'
import { releaseVersion } from './release-version.mjs'

const root = resolve(import.meta.dirname, '..')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
export function compareVersions(a, b) {
  releaseVersion(a)
  releaseVersion(b)
  const parts = version => version.split(/\.|-beta\./).map(Number)
  const left = parts(a), right = parts(b)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  if (left.length !== right.length) return left.length === 3 ? 1 : -1
  return left[3] === right[3] ? 0 : left[3] > right[3] ? 1 : -1
}

export function checkReport(report, checkout, requirePackage = true) {
  if (report.numRuntimeErrorTestSuites || report.unhandledErrors?.length) throw new Error('Test runtime errors')
  if (!report.testResults?.length) throw new Error('Test report is empty or incomplete')
  let total = 0, packagePassed = 0
  for (const suite of report.testResults) {
    const file = relative(checkout, suite.name).replaceAll('\\', '/')
    for (const test of suite.assertionResults) {
      total++
      if (test.status === 'failed') {
        const key = JSON.stringify([file, ...test.ancestorTitles, test.title])
        throw new Error(`Unexpected failure: ${key}`)
      }
      if (file === 'test/publish.test.ts' && test.status === 'passed') packagePassed++
    }
    // Vitest serializes hook/collection failures as a failed suite with a message.
    if (suite.message || suite.status === 'failed') throw new Error(`Test suite error: ${file}: ${suite.message}`)
  }
  if (total !== report.numTotalTests || report.numFailedTests !== 0) throw new Error('Test report incomplete')
  if (requirePackage && !packagePassed) throw new Error('The package artifact tests did not pass')
  return { total, packagePassed }
}

/** Every file a release carries, by the job that builds it. */
export function platformArtifacts(version) {
  const { feeds } = releaseVersion(version)
  const mac = arch => [`Tnega-${version}-${arch}.dmg`, `Tnega-${version}-mac-${arch}.zip`, `Tnega-${version}-mac-${arch}.zip.blockmap`]
  return {
    npm: [`tnega-${version}.tgz`],
    windows: [`Tnega-Setup-${version}.exe`, `Tnega-Setup-${version}.exe.blockmap`, feeds.windows],
    'mac-arm64': mac('arm64'),
    'mac-x64': mac('x64'),
    linux: [`Tnega-${version}-x86_64.AppImage`, `Tnega-${version}-amd64.deb`, feeds.linux],
  }
}
function artifactNames(version) {
  const { feeds } = releaseVersion(version)
  const groups = platformArtifacts(version)
  // Both Mac jobs write half of the Mac feed; `bundle` joins them into one.
  return [...groups.npm, ...groups.windows, ...groups['mac-arm64'], ...groups['mac-x64'], feeds.mac, ...groups.linux]
}
const macPart = (feed, arch) => `${feed}.${arch}.part`

/** The subset of electron-builder's update feed YAML that the release reads and writes. */
export function parseFeed(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const start = lines.indexOf('files:')
  if (start < 0) throw new Error('Update feed has no files')
  let end = start + 1
  while (end < lines.length && lines[end].startsWith('  ')) end++
  const top = key => lines.find(line => line.startsWith(`${key}: `))?.slice(key.length + 2).trim()
  const entries = lines.slice(start + 1, end).join('\n').split(/\n(?= {2}- )/).filter(Boolean).map(block => {
    const field = key => new RegExp(`^(?:  - |    )${key}: (.+)$`, 'm').exec(block)?.[1]?.trim()
    return { url: field('url'), sha512: field('sha512'), size: Number(field('size')), lines: block.split('\n') }
  })
  return { version: top('version'), path: top('path'), sha512: top('sha512'), entries, before: lines.slice(0, start), after: lines.slice(end) }
}

/** One Mac feed listing both architectures; the first part keeps its legacy top-level `path`. */
export function mergeFeeds(texts) {
  const feeds = texts.map(parseFeed)
  if (!feeds.length || new Set(feeds.map(feed => feed.version)).size !== 1) throw new Error('Mac feed parts describe different versions')
  const [first] = feeds
  return [...first.before, 'files:', ...feeds.flatMap(feed => feed.entries.flatMap(entry => entry.lines)), ...first.after].join('\n')
}

/** Each file a feed names must be in the bundle with the bytes it declares. */
export function verifyFeed(dir, name, version, required) {
  const feed = parseFeed(readFileSync(join(dir, name), 'utf8'))
  if (feed.version !== version) throw new Error(`${name} does not describe ${version}`)
  for (const entry of feed.entries) {
    if (!entry.url || entry.url.includes('/')) throw new Error(`${name} names an invalid file`)
    const bytes = readFileSync(join(dir, entry.url))
    if (bytes.length !== entry.size || digest(bytes, 'sha512', 'base64') !== entry.sha512) throw new Error(`${name} does not match ${entry.url}`)
  }
  for (const url of required) {
    if (feed.entries.filter(entry => entry.url === url).length !== 1) throw new Error(`${name} does not list ${url}`)
  }
  const main = feed.entries.find(entry => entry.url === feed.path)
  if (!main || main.sha512 !== feed.sha512) throw new Error(`${name} has an inconsistent top-level path`)
}

export function verifyBundle(dir, version, commit) {
  const manifest = readJson(join(dir, 'manifest.json'))
  if (manifest.version !== version || manifest.commit !== commit) throw new Error('Artifact identity does not match the tag')
  const expected = artifactNames(version)
  if (manifest.files.length !== expected.length || expected.some(name => manifest.files.filter(file => file.name === name).length !== 1)) {
    throw new Error('Artifact manifest has an unexpected file set')
  }
  for (const file of manifest.files) {
    const bytes = readFileSync(join(dir, file.name))
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error(`Artifact hash/size mismatch: ${file.name}`)
  }
  const groups = platformArtifacts(version)
  const { feeds } = releaseVersion(version)
  const tar = readFileSync(join(dir, groups.npm[0]))
  if (`sha512-${digest(tar, 'sha512', 'base64')}` !== manifest.npmIntegrity) throw new Error('npm integrity mismatch')
  verifyFeed(dir, feeds.windows, version, [groups.windows[0]])
  verifyFeed(dir, feeds.mac, version, [groups['mac-arm64'][1], groups['mac-x64'][1]])
  verifyFeed(dir, feeds.linux, version, [groups.linux[0], groups.linux[1]])
  return manifest
}

/**
 * Copy one build job's files from `apps/desktop/release` into the bundle
 * directory. electron-builder names its feed `latest-*` whatever the channel.
 */
export function stagePlatform(platform, version, from, to) {
  const groups = platformArtifacts(version)
  const { feeds } = releaseVersion(version)
  if (!(platform in groups) || platform === 'npm') throw new Error(`Unknown platform ${platform}`)
  mkdirSync(to, { recursive: true })
  const builderFeed = kind => {
    const found = [`latest-${kind}.yml`, `beta-${kind}.yml`].filter(name => existsSync(join(from, name)))
    if (found.length !== 1) throw new Error(`Expected one ${kind} update feed in ${from}`)
    return join(from, found[0])
  }
  for (const name of groups[platform]) {
    const source = platform === 'linux' && name === feeds.linux ? builderFeed('linux') : join(from, name)
    copyFileSync(source, join(to, name))
  }
  if (platform.startsWith('mac-')) copyFileSync(builderFeed('mac'), join(to, macPart(feeds.mac, platform.slice(4))))
}

export function checkAssets(assets, manifest) {
  for (const file of manifest.files.filter(file => !file.name.endsWith('.tgz'))) {
    const matches = assets.filter(asset => asset.name === file.name)
    if (matches.length !== 1 || matches[0].size !== file.size || matches[0].digest !== `sha256:${file.sha256}`) {
      throw new Error(`Release asset missing, duplicated or changed: ${file.name}`)
    }
  }
}

function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() }
export function checkTag(tag) {
  const version = tag?.startsWith('v') ? tag.slice(1) : ''
  const metadata = releaseVersion(version)
  if (readJson(join(root, 'package.json')).version !== version || readJson(join(root, 'apps/desktop/package.json')).version !== version) throw new Error('Tag and package versions differ')
  readFileSync(join(root, `docs/releases/${tag}.md`), 'utf8')
  if (!readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n').some(line => line.startsWith(`## [${version}]`) || line.trim() === `## ${version}`)) throw new Error('Missing released changelog section')
  if (git('rev-parse', 'HEAD') !== git('rev-parse', `${tag}^{commit}`)) throw new Error('Checkout is not the tag commit')
  git('merge-base', '--is-ancestor', 'HEAD', 'origin/main')
  return metadata
}

async function main() {
  const [command, argument] = process.argv.slice(2)
  if (command === 'test') {
    const reportFile = join(root, '.tnega/release-ci-tests.json')
    const errorsFile = join(root, '.tnega/release-ci-errors.json')
    mkdirSync(dirname(reportFile), { recursive: true })
    rmSync(reportFile, { force: true })
    rmSync(errorsFile, { force: true })
    const require = createRequire(import.meta.url)
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
    const result = spawnSync(process.execPath, [vitest, 'run', '--maxWorkers', '2', '--reporter=default', '--reporter=json', '--reporter=./scripts/release-test-reporter.mjs', `--outputFile.json=${reportFile}`], { cwd: root, stdio: 'inherit' })
    if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error(`Vitest process failed: ${result.error ?? result.signal ?? result.status}`)
    const runtime = readJson(errorsFile)
    if (runtime.errors.length || !['passed', 'failed'].includes(runtime.reason)) throw new Error(`Test runtime error or interrupted run: ${JSON.stringify(runtime)}`)
    const checked = checkReport(readJson(reportFile), root)
    if (checked.total < 1200 || checked.packagePassed < 12 || result.status !== 0) throw new Error('Full suite or package checks did not complete')
    console.log(`Release gate: ${checked.total} tests passed with no failures`)
  } else if (command === 'check') {
    const metadata = checkTag(argument)
    console.log(`Tag v${metadata.version} is ready for CI`)
  } else if (command === 'stage') {
    // Usage: stage <windows|mac-arm64|mac-x64|linux> v<version>
    const { version } = checkTag(process.argv[4])
    stagePlatform(argument, version, join(root, 'apps/desktop/release'), join(root, '.tnega/release-ci'))
    console.log(`Staged ${argument} artifacts for v${version}`)
  } else if (command === 'bundle') {
    const { version, feeds } = checkTag(argument)
    const dir = join(root, '.tnega/release-ci')
    const parts = ['arm64', 'x64'].map(arch => join(dir, macPart(feeds.mac, arch)))
    writeFileSync(join(dir, feeds.mac), mergeFeeds(parts.map(part => readFileSync(part, 'utf8'))))
    for (const part of parts) rmSync(part)
    const files = artifactNames(version).map(name => {
      const bytes = readFileSync(join(dir, name))
      return { name, size: bytes.length, sha256: digest(bytes) }
    })
    const npmIntegrity = `sha512-${digest(readFileSync(join(dir, `tnega-${version}.tgz`)), 'sha512', 'base64')}`
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, commit: git('rev-parse', 'HEAD'), npmIntegrity, files }, null, 2) + '\n')
    verifyBundle(dir, version, git('rev-parse', 'HEAD'))
  } else if (command === 'verify') {
    const { version } = checkTag(argument)
    verifyBundle(join(root, '.tnega/release-ci'), version, git('rev-parse', 'HEAD'))
  } else throw new Error('Usage: release-ci.mjs <check|test|stage|bundle|verify> [platform] [v<version>]')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

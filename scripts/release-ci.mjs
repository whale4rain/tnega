// Read-only gates and fixed artifact preparation for the tag release workflow.
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
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

function artifactNames(version) {
  const { feed } = releaseVersion(version)
  return [`tnega-${version}.tgz`, `Tnega-Setup-${version}.exe`, `Tnega-Setup-${version}.exe.blockmap`, feed]
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
  const tar = readFileSync(join(dir, expected[0]))
  if (`sha512-${digest(tar, 'sha512', 'base64')}` !== manifest.npmIntegrity) throw new Error('npm integrity mismatch')
  const installer = readFileSync(join(dir, expected[1]))
  const feed = readFileSync(join(dir, expected[3]), 'utf8')
  const sha512 = digest(installer, 'sha512', 'base64')
  if (!feed.includes(`version: ${version}\n`) || !feed.includes(`path: ${expected[1]}\n`) ||
      !feed.includes(`  - url: ${expected[1]}\n`) || !feed.includes(`    size: ${installer.length}\n`) ||
      !feed.includes(`    sha512: ${sha512}\n`) || !feed.includes(`\nsha512: ${sha512}\n`)) throw new Error('Update feed does not match the installer')
  return manifest
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
  } else if (command === 'bundle') {
    const { version } = checkTag(argument)
    const dir = join(root, '.tnega/release-ci')
    mkdirSync(dir, { recursive: true })
    const files = artifactNames(version).map(name => {
      if (!name.endsWith('.tgz')) copyFileSync(join(root, 'apps/desktop/release', name), join(dir, name))
      const bytes = readFileSync(join(dir, name))
      return { name, size: bytes.length, sha256: digest(bytes) }
    })
    const npmIntegrity = `sha512-${digest(readFileSync(join(dir, `tnega-${version}.tgz`)), 'sha512', 'base64')}`
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, commit: git('rev-parse', 'HEAD'), npmIntegrity, files }, null, 2) + '\n')
    verifyBundle(dir, version, git('rev-parse', 'HEAD'))
  } else if (command === 'verify') {
    const { version } = checkTag(argument)
    verifyBundle(join(root, '.tnega/release-ci'), version, git('rev-parse', 'HEAD'))
  } else throw new Error('Usage: release-ci.mjs <check|test|bundle|verify> [v<version>]')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

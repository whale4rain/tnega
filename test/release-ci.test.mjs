import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { checkReport, compareVersions, verifyBundle, checkAssets } from '../scripts/release-ci.mjs'
import { publishRelease } from '../scripts/release-publish.mjs'

const root = '/checkout'
function report(status = 'passed', title = 'works') {
  return { numTotalTests: 1, numFailedTests: status === 'failed' ? 1 : 0,
    numRuntimeErrorTestSuites: 0, testResults: [{ name: `${root}/test/publish.test.ts`,
      status, message: '', assertionResults: [{ ancestorTitles: ['package'], title, status }] }] }
}
test('all test failures and runtime/hook errors block publication', () => {
  assert.doesNotThrow(() => checkReport(report(), root))
  assert.throws(() => checkReport(report('failed', 'old failure'), root, false), /Unexpected/)
  assert.throws(() => checkReport(report('failed', 'new failure'), root, false), /Unexpected/)
  assert.throws(() => checkReport({ ...report(), numRuntimeErrorTestSuites: 1 }, root), /runtime/)
  assert.throws(() => checkReport({ ...report(), testResults: [] }, root), /empty|incomplete/)
  const hook = report()
  hook.testResults[0].status = 'failed'
  hook.testResults[0].message = 'beforeAll failed'
  assert.throws(() => checkReport(hook, root), /suite/)
})
test('package tests must pass and partial reports cannot approve publication', () => {
  assert.throws(() => checkReport(report('failed', 'old failure'), root), /Unexpected/)
  assert.throws(() => checkReport({ ...report(), numTotalTests: 10 }, root), /incomplete/)
  const skipped = report('pending')
  assert.throws(() => checkReport(skipped, root), /package/)
})
test('a denied-write regression blocks publication', () => {
  const result = report('failed', 'denies writes')
  result.testResults[0].assertionResults[0].failureMessages = ['expected true to be false']
  assert.throws(() => checkReport(result, root, false), /Unexpected/)
})
test('stable promotion and numeric beta ordering prevent channel downgrade', () => {
  assert.equal(compareVersions('0.4.12-beta.10', '0.4.12-beta.2'), 1)
  assert.equal(compareVersions('0.4.12', '0.4.12-beta.10'), 1)
  assert.equal(compareVersions('0.4.11', '0.4.12'), -1)
  assert.throws(() => compareVersions('v0.4.12', '0.4.12'))
})
test('fixed bundle hashes and identity reject changed bytes and wrong tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-ci-'))
  try {
    const version = '0.4.12'
    const names = [`tnega-${version}.tgz`, `Tnega-Setup-${version}.exe`, `Tnega-Setup-${version}.exe.blockmap`, 'latest.yml']
    const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
    const sha512 = hash('fixed bytes', 'sha512', 'base64')
    const feed = `version: ${version}\nfiles:\n  - url: ${names[1]}\n    sha512: ${sha512}\n    size: 11\npath: ${names[1]}\nsha512: ${sha512}\n`
    const files = names.map(name => {
      const bytes = name.endsWith('.yml') ? feed : 'fixed bytes'
      writeFileSync(join(dir, name), bytes)
      return { name, size: bytes.length, sha256: hash(bytes) }
    })
    const manifest = { version, commit: 'a'.repeat(40), files, npmIntegrity: `sha512-${sha512}` }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    assert.doesNotThrow(() => verifyBundle(dir, version, manifest.commit))
    assert.throws(() => verifyBundle(dir, version, 'b'.repeat(40)), /identity/)
    writeFileSync(join(dir, names[0]), 'changed bytes')
    assert.throws(() => verifyBundle(dir, version, manifest.commit), /hash|size/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function publisherFixture({ version = '0.4.12', published = false, existingNpm = false, wrongNpm = false, wrongAsset = false, channel = version } = {}) {
  const preview = version.includes('-beta.')
  const manifest = { version, npmIntegrity: 'sha512-fixed', files: [
    { name: `tnega-${version}.tgz`, size: 10, sha256: 'npm' },
    { name: 'installer.exe', size: 42, sha256: 'abc' },
  ] }
  const calls = []
  let npmExists = existingNpm
  const release = { id: 123, tag_name: `v${version}`, draft: !published, prerelease: preview,
    assets: [{ name: 'installer.exe', size: 42, digest: wrongAsset ? 'sha256:other' : 'sha256:abc' }] }
  const deps = {
    run(binary, args) {
      calls.push([binary, ...args])
      if (binary === 'npm') npmExists = true
      if (args.includes('--draft=false')) release.draft = false
    },
    json(args) {
      assert.ok(args.includes('--slurp') || args.includes('repos/whale4rain/tnega/releases/123'))
      return args.includes('--slurp') ? [[release]] : release
    },
    async registry(path) {
      if (path === 'tnega') return { 'dist-tags': { [preview ? 'preview' : 'latest']: channel } }
      return npmExists ? { dist: { integrity: wrongNpm ? 'sha512-other' : 'sha512-fixed' } } : undefined
    },
    async wait() {},
  }
  return { manifest, calls, deps, release }
}
test('publisher uploads and verifies the draft before npm and release visibility', async () => {
  const fixture = publisherFixture()
  await publishRelease(fixture.manifest, '/fixed', fixture.deps)
  assert.equal(fixture.calls.length, 3)
  assert.ok(fixture.calls[0].includes('upload'))
  assert.equal(fixture.calls[1][0], 'npm')
  assert.ok(fixture.calls[1].includes('--ignore-scripts'))
  assert.ok(fixture.calls[2].includes('--draft=false'))
})
test('retry skips immutable npm and published GitHub artifacts', async () => {
  const fixture = publisherFixture({ published: true, existingNpm: true })
  await publishRelease(fixture.manifest, '/fixed', fixture.deps)
  assert.deepEqual(fixture.calls, [])
})
test('different published bytes and channel downgrade fail before any mutations', async () => {
  for (const options of [{ existingNpm: true, wrongNpm: true }, { published: true, wrongAsset: true }, { channel: '0.4.13' }]) {
    const fixture = publisherFixture(options)
    await assert.rejects(publishRelease(fixture.manifest, '/fixed', fixture.deps), /different|asset|downgrade/)
    assert.deepEqual(fixture.calls, [])
  }
})
test('failed npm propagation preserves the draft for a retry', async () => {
  const fixture = publisherFixture({ channel: '0.4.11' })
  await assert.rejects(publishRelease(fixture.manifest, '/fixed', fixture.deps), /not visible/)
  assert.ok(fixture.calls.every(call => !call.includes('--draft=false')))
})
test('publisher waits through delayed npm processing before publishing the draft', async () => {
  const fixture = publisherFixture({ channel: '0.4.11' })
  let polls = 0
  fixture.deps.registry = async path => {
    if (path === 'tnega') {
      return { 'dist-tags': { latest: polls >= 40 ? fixture.manifest.version : '0.4.11' } }
    }
    return polls >= 40 ? { dist: { integrity: fixture.manifest.npmIntegrity } } : undefined
  }
  fixture.deps.wait = async () => { polls++ }

  await publishRelease(fixture.manifest, '/fixed', fixture.deps)

  assert.equal(polls, 40)
  assert.ok(fixture.calls.some(call => call[0] === 'npm'))
  assert.ok(fixture.calls.some(call => call.includes('--draft=false')))
})
test('beta publication uses preview and does not become the latest GitHub release', async () => {
  const fixture = publisherFixture({ version: '0.4.12-beta.1' })
  await publishRelease(fixture.manifest, '/fixed', fixture.deps)
  assert.ok(fixture.calls[1].includes('preview'))
  assert.ok(fixture.calls[2].includes('--latest=false'))
})
test('create exactly one draft before uploading; duplicate releases stop before mutation', async () => {
  const fixture = publisherFixture()
  let created = false
  fixture.deps.json = args => {
    assert.ok(args.includes('--slurp') || args.includes('repos/whale4rain/tnega/releases/123'))
    return args.includes('--slurp') ? (created ? [[fixture.release]] : []) : fixture.release
  }
  const originalRun = fixture.deps.run
  fixture.deps.run = (binary, args) => {
    if (args.includes('create')) {
      assert.ok(args.includes('--draft'))
      created = true
    } else assert.equal(created, true)
    originalRun(binary, args)
  }
  await publishRelease(fixture.manifest, '/fixed', fixture.deps)
  assert.equal(fixture.calls.filter(call => call.includes('create')).length, 1)
  const duplicate = publisherFixture()
  duplicate.deps.json = () => [[duplicate.release, duplicate.release]]
  await assert.rejects(publishRelease(duplicate.manifest, '/fixed', duplicate.deps), /Duplicate/)
  assert.deepEqual(duplicate.calls, [])
})
test('published release retries require every asset digest, no missing or duplicate assets', () => {
  const manifest = { files: [{ name: 'installer.exe', size: 42, sha256: 'abc' }] }
  const assets = [{ name: 'installer.exe', size: 42, digest: 'sha256:abc' }]
  assert.doesNotThrow(() => checkAssets(assets, manifest))
  assert.throws(() => checkAssets([], manifest), /asset/)
  assert.throws(() => checkAssets([...assets, ...assets], manifest), /asset/)
  assert.throws(() => checkAssets([{ ...assets[0], digest: 'sha256:changed' }], manifest), /asset/)
})

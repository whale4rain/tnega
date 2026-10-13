import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { checkReport, compareVersions, verifyBundle, checkAssets, mergeFeeds, parseFeed, platformArtifacts, stagePlatform, verifyFeed } from '../scripts/release-ci.mjs'
import { releaseVersion } from '../scripts/release-version.mjs'
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
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const feedEntry = (name, bytes) => `  - url: ${name}\n    sha512: ${hash(bytes, 'sha512', 'base64')}\n    size: ${bytes.length}\n`
const feedFor = (version, names) => `version: ${version}\nfiles:\n${names.map(([name, bytes]) => feedEntry(name, bytes)).join('')}` +
  `path: ${names[0][0]}\nsha512: ${hash(names[0][1], 'sha512', 'base64')}\nreleaseDate: '2026-10-12T00:00:00.000Z'\n`

/** A complete bundle for every platform, as `release-ci.mjs bundle` writes it. */
function writeBundle(dir, version) {
  const groups = platformArtifacts(version)
  const { feeds } = releaseVersion(version)
  const contents = new Map()
  for (const name of Object.values(groups).flat()) contents.set(name, `bytes of ${name}`)
  contents.set(feeds.windows, feedFor(version, [[groups.windows[0], contents.get(groups.windows[0])]]))
  contents.set(feeds.linux, feedFor(version, groups.linux.slice(0, 2).map(name => [name, contents.get(name)])))
  contents.set(feeds.mac, mergeFeeds(['arm64', 'x64'].map(arch => {
    const [dmg, zip] = groups[`mac-${arch}`]
    return feedFor(version, [[zip, contents.get(zip)], [dmg, contents.get(dmg)]])
  })))
  const files = [...contents].map(([name, bytes]) => {
    writeFileSync(join(dir, name), bytes)
    return { name, size: bytes.length, sha256: hash(bytes) }
  })
  const manifest = { version, commit: 'a'.repeat(40), files, npmIntegrity: `sha512-${hash(contents.get(groups.npm[0]), 'sha512', 'base64')}` }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { manifest, groups, feeds, contents }
}

test('fixed bundle hashes and identity reject changed bytes and wrong tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-ci-'))
  try {
    const version = '0.4.12'
    const { manifest, groups } = writeBundle(dir, version)
    assert.doesNotThrow(() => verifyBundle(dir, version, manifest.commit))
    assert.throws(() => verifyBundle(dir, version, 'b'.repeat(40)), /identity/)
    writeFileSync(join(dir, groups.npm[0]), 'changed bytes')
    assert.throws(() => verifyBundle(dir, version, manifest.commit), /hash|size/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('every platform ships with a feed that names its exact installer bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-ci-'))
  try {
    const version = '0.5.0-beta.1'
    const { groups, feeds } = writeBundle(dir, version)
    assert.deepEqual(feeds, { windows: 'beta.yml', mac: 'beta-mac.yml', linux: 'beta-linux.yml' })
    assert.deepEqual(groups.linux, ['Tnega-0.5.0-beta.1-x86_64.AppImage', 'Tnega-0.5.0-beta.1-amd64.deb', 'beta-linux.yml'])
    assert.doesNotThrow(() => verifyFeed(dir, feeds.mac, version, [groups['mac-arm64'][1], groups['mac-x64'][1]]))
    const mac = parseFeed(readFileSync(join(dir, feeds.mac), 'utf8'))
    assert.deepEqual(mac.entries.map(entry => entry.url), [groups['mac-arm64'][1], groups['mac-arm64'][0], groups['mac-x64'][1], groups['mac-x64'][0]])
    assert.equal(mac.path, groups['mac-arm64'][1])
    // A feed that leaves out an architecture, or points at other bytes, cannot ship.
    assert.throws(() => verifyFeed(dir, feeds.mac, version, ['Tnega-0.5.0-beta.1-mac-universal.zip']), /does not list/)
    writeFileSync(join(dir, groups.linux[1]), 'rebuilt deb')
    assert.throws(() => verifyFeed(dir, feeds.linux, version, [groups.linux[0]]), /does not match/)
    assert.throws(() => verifyFeed(dir, feeds.windows, '0.5.0', []), /does not describe/)
    assert.throws(() => mergeFeeds([feedFor('0.5.0', [['a.zip', 'a']]), feedFor('0.5.1', [['b.zip', 'b']])]), /different versions/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('staging takes electron-builder\'s latest-* feed for either channel and keeps Mac halves apart', () => {
  const from = mkdtempSync(join(tmpdir(), 'release-build-'))
  const to = mkdtempSync(join(tmpdir(), 'release-stage-'))
  try {
    const version = '0.5.0-beta.1'
    const groups = platformArtifacts(version)
    for (const name of [...groups['mac-arm64'], ...groups.linux.slice(0, 2)]) writeFileSync(join(from, name), name)
    writeFileSync(join(from, 'latest-mac.yml'), 'mac feed')
    writeFileSync(join(from, 'latest-linux.yml'), 'linux feed')
    stagePlatform('mac-arm64', version, from, to)
    stagePlatform('linux', version, from, to)
    assert.deepEqual(readdirSync(to).sort(), [...groups['mac-arm64'], ...groups.linux, 'beta-mac.yml.arm64.part'].sort())
    assert.equal(readFileSync(join(to, 'beta-linux.yml'), 'utf8'), 'linux feed')
    writeFileSync(join(from, 'beta-linux.yml'), 'second feed')
    assert.throws(() => stagePlatform('linux', version, from, to), /one linux update feed/)
    assert.throws(() => stagePlatform('npm', version, from, to), /Unknown platform/)
  } finally {
    rmSync(from, { recursive: true, force: true })
    rmSync(to, { recursive: true, force: true })
  }
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
test('publisher makes verified desktop assets public before npm publication', async () => {
  const fixture = publisherFixture()
  await publishRelease(fixture.manifest, '/fixed', fixture.deps)
  assert.equal(fixture.calls.length, 3)
  assert.ok(fixture.calls[0].includes('upload'))
  assert.ok(fixture.calls[1].includes('--draft=false'))
  assert.equal(fixture.calls[2][0], 'npm')
  assert.ok(fixture.calls[2].includes('--ignore-scripts'))
})
test('retry skips immutable npm and published GitHub artifacts', async () => {
  const fixture = publisherFixture({ published: true, existingNpm: true })
  await publishRelease(fixture.manifest, '/fixed', fixture.deps)
  assert.deepEqual(fixture.calls, [])
})
test('invalid npm bytes or channel block npm while preserving the verified desktop release', async () => {
  for (const options of [{ existingNpm: true, wrongNpm: true }, { published: true, wrongAsset: true }, { channel: '0.4.13' }]) {
    const fixture = publisherFixture(options)
    await assert.rejects(publishRelease(fixture.manifest, '/fixed', fixture.deps), /different|asset|downgrade/)
    assert.ok(fixture.calls.every(call => call[0] !== 'npm'))
    if (options.wrongAsset) assert.deepEqual(fixture.calls, [])
    else assert.equal(fixture.release.draft, false)
  }
})
test('failed npm propagation leaves the verified desktop release public', async () => {
  const fixture = publisherFixture({ channel: '0.4.11' })
  await assert.rejects(publishRelease(fixture.manifest, '/fixed', fixture.deps), /not visible/)
  assert.equal(fixture.release.draft, false)
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

test('npm registry unavailability cannot block a verified desktop release', async () => {
  const fixture = publisherFixture()
  fixture.deps.registry = async () => { throw new Error('registry unavailable') }
  await assert.rejects(publishRelease(fixture.manifest, '/fixed', fixture.deps), /registry unavailable/)
  assert.equal(fixture.release.draft, false)
  assert.ok(fixture.calls.every(call => call[0] !== 'npm'))
})

test('production wait honors each registry retry delay', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = publisherFixture()
  delete fixture.deps.wait
  let reads = 0
  fixture.deps.registry = async path => {
    if (path === 'tnega') return { 'dist-tags': { latest: fixture.manifest.version } }
    reads++
    return reads >= 5 ? { dist: { integrity: fixture.manifest.npmIntegrity } } : undefined
  }
  const publishing = publishRelease(fixture.manifest, '/fixed', fixture.deps)
  await setImmediate()
  assert.equal(reads, 2)
  for (const [delay, expected] of [[5000, 3], [10000, 4], [20000, 5]]) {
    context.mock.timers.tick(delay - 1)
    await setImmediate()
    assert.equal(reads, expected - 1)
    context.mock.timers.tick(1)
    await setImmediate()
    assert.equal(reads, expected)
  }
  await publishing
})
test('beta publication uses preview and does not become the latest GitHub release', async () => {
  const fixture = publisherFixture({ version: '0.4.12-beta.1' })
  await publishRelease(fixture.manifest, '/fixed', fixture.deps)
  assert.ok(fixture.calls[2].includes('preview'))
  assert.ok(fixture.calls[1].includes('--latest=false'))
})
test('create exactly one draft before uploading; duplicate releases stop before mutation', async () => {
  const fixture = publisherFixture()
  let created = false
  fixture.deps.json = args => {
    if (args.includes('POST')) {
      assert.ok(args.includes('draft=true'))
      assert.ok(args.includes(`tag_name=${fixture.release.tag_name}`))
      created = true
      fixture.calls.push(['gh', ...args])
      return fixture.release
    }
    if (args.includes(`repos/whale4rain/tnega/git/ref/tags/${fixture.release.tag_name}`)) return { ref: `refs/tags/${fixture.release.tag_name}` }
    assert.ok(args.includes('--slurp') || args.includes('repos/whale4rain/tnega/releases/123'))
    // The list can remain stale after creation; only the POST response is authoritative.
    return args.includes('--slurp') ? [] : fixture.release
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
  assert.equal(fixture.calls.filter(call => call.includes('POST')).length, 1)
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

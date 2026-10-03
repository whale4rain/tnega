import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

test.each([
  { version: '0.4.7-beta.1', feed: 'beta.yml', tag: 'preview' },
  { version: '0.4.7', feed: 'latest.yml', tag: 'latest' },
])('prepares $version and the matching update feed without publishing', ({ version, feed, tag }) => {
  const root = mkdtempSync(join(tmpdir(), 'tnega-release-'))
  try {
    for (const dir of ['scripts', 'apps/desktop/release', 'docs/releases']) mkdirSync(join(root, dir), { recursive: true })
    copyFileSync(resolve('scripts/release.mjs'), join(root, 'scripts/release.mjs'))
    copyFileSync(resolve('scripts/release-version.mjs'), join(root, 'scripts/release-version.mjs'))
    for (const file of ['package.json', 'apps/desktop/package.json']) writeFileSync(join(root, file), JSON.stringify({ version: '0.4.6' }))
    const run = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), ...args], { encoding: 'utf8' })
    const bump = run(['version', version])
    expect(bump.status, bump.stderr).toBe(0)
    for (const file of ['package.json', 'apps/desktop/package.json']) expect(JSON.parse(readFileSync(join(root, file), 'utf8')).version).toBe(version)
    const notes = readFileSync(join(root, `docs/releases/v${version}.md`), 'utf8')
    expect(notes).toContain(`npm install -g tnega@${version}`)
    expect(bump.stdout).toContain(`npm publish --tag ${tag}`)
    writeFileSync(join(root, `apps/desktop/release/Tnega-Setup-${version}.exe`), 'fixture installer')
    const result = run(['feed'])
    expect(result.status, result.stderr).toBe(0)
    const text = readFileSync(join(root, `apps/desktop/release/${feed}`), 'utf8')
    expect(text).toContain(`version: ${version}`)
    expect(text).toContain(`path: Tnega-Setup-${version}.exe`)
    expect(existsSync(join(root, `apps/desktop/release/${feed === 'beta.yml' ? 'latest.yml' : 'beta.yml'}`))).toBe(false)
    const fetchFixture = join(root, 'fetch-fixture.mjs')
    const writeFetchFixture = (prerelease: boolean) => writeFileSync(fetchFixture, `
      globalThis.fetch = async input => {
        const url = String(input)
        if (url.endsWith('/${feed}')) return new Response(${JSON.stringify(text)})
        if (url.endsWith('.exe')) return new Response(null, { headers: { 'content-length': '17' } })
        if (url.includes('api.github.com')) return Response.json({ draft: false, prerelease: ${prerelease} })
        if (url.endsWith('/latest')) return new Response(null, { status: 302, headers: { location: 'https://github.com/whale4rain/tnega/releases/tag/v${version}' } })
        throw new Error('Unexpected external request: ' + url)
      }
    `)
    writeFetchFixture(tag === 'preview')
    const verify = () => spawnSync(process.execPath, ['--import', pathToFileURL(fetchFixture).href, join(root, 'scripts/release.mjs'), 'verify', version], { encoding: 'utf8' })
    const verified = verify()
    expect(verified.status, verified.stderr).toBe(0)
    writeFetchFixture(tag !== 'preview')
    expect(verify().status).not.toBe(0)
    const rejected = run(['version', '0.4.8-preview.1'])
    expect(rejected.status).not.toBe(0)
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe(version)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

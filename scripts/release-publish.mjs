// This entry point is used only by the GitHub-hosted OIDC publisher job.
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import process from 'node:process'
import console from 'node:console'
import { checkTag, verifyBundle, compareVersions, checkAssets } from './release-ci.mjs'
import { releaseVersion } from './release-version.mjs'

const repo = 'whale4rain/tnega'
const root = resolve(import.meta.dirname, '..')
function command(binary, args) {
  return execFileSync(binary, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}
async function registry(path) {
  const response = await globalThis.fetch(`https://registry.npmjs.org/${path}`)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
  return response.json()
}
const ghJson = args => JSON.parse(command('gh', args))

// Dependencies are injected for offline tests; production never supplies them.
export async function publishRelease(manifest, dir, deps = {}) {
  const run = deps.run ?? command
  const json = deps.json ?? ghJson
  const npm = deps.registry ?? registry
  const wait = deps.wait ?? (() => setTimeout(5000))
  const metadata = releaseVersion(manifest.version)
  const tag = `v${manifest.version}`
  const releases = json(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]).flat()
  const matches = releases.filter(release => release.tag_name === tag)
  if (matches.length > 1) throw new Error('Duplicate releases exist; resolve them before retrying')
  let release = matches[0]
  if (release && release.prerelease !== metadata.preview) throw new Error('Release channel mismatch')
  if (release && !release.draft) checkAssets(release.assets, manifest)
  for (const published of releases.filter(item => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name))) {
    if (compareVersions(published.tag_name.slice(1), manifest.version) > 0) throw new Error('A newer stable desktop release exists')
  }
  const packageInfo = await npm('tnega')
  const channel = packageInfo?.['dist-tags']?.[metadata.npmTag]
  if (channel && compareVersions(channel, manifest.version) > 0) throw new Error(`Refusing to downgrade npm ${metadata.npmTag}`)
  let existing = await npm(`tnega/${manifest.version}`)
  if (existing && existing.dist?.integrity !== manifest.npmIntegrity) throw new Error('npm version already exists with different bytes')

  if (!release) {
    const args = ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--title', `Tnega ${tag}`, '--notes-file', `docs/releases/${tag}.md`]
    if (metadata.preview) args.push('--prerelease')
    run('gh', args)
    release = json(['api', `repos/${repo}/releases/tags/${tag}`])
  }
  if (release.draft) {
    const paths = manifest.files.filter(file => !file.name.endsWith('.tgz')).map(file => join(dir, file.name))
    run('gh', ['release', 'upload', tag, ...paths, '--repo', repo, '--clobber'])
    release = json(['api', `repos/${repo}/releases/tags/${tag}`])
    checkAssets(release.assets, manifest)
  }
  if (!existing) {
    run('npm', ['publish', join(dir, `tnega-${manifest.version}.tgz`), '--ignore-scripts', '--access', 'public', '--provenance', '--tag', metadata.npmTag, '--registry=https://registry.npmjs.org'])
  }
  // Registry propagation is asynchronous. A timeout preserves the verified draft.
  let visible = false
  for (let attempt = 0; attempt < 36; attempt++) {
    existing = await npm(`tnega/${manifest.version}`)
    const tags = (await npm('tnega'))?.['dist-tags']
    if (existing && existing.dist?.integrity !== manifest.npmIntegrity) throw new Error('Published npm integrity differs')
    if (existing && tags?.[metadata.npmTag] === manifest.version) { visible = true; break }
    await wait()
  }
  if (!visible) throw new Error('npm version/channel not visible yet; rerun the failed publisher job after propagation')
  if (release.draft) {
    run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', `--latest=${metadata.preview ? 'false' : 'true'}`])
  }
  const final = json(['api', `repos/${repo}/releases/tags/${tag}`])
  if (final.draft || final.prerelease !== metadata.preview) throw new Error('Release was not published on the expected channel')
  checkAssets(final.assets, manifest)
  console.log(`Published ${tag}: npm ${metadata.npmTag}, installer, blockmap and ${metadata.feed}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repo) throw new Error('Use this publisher only in the trusted repository Actions workflow')
  const metadata = checkTag(process.env.GITHUB_REF_NAME)
  const commit = command('git', ['rev-parse', 'HEAD'])
  const dir = join(root, '.tnega/release-ci')
  await publishRelease(verifyBundle(dir, metadata.version, commit), dir)
}

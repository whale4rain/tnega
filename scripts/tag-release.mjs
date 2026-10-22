// Tag the current version and push the tag, which starts the Release workflow.
//
//   pnpm release:tag
//
// It pulls main, checks that CHANGELOG.md and docs/releases have this version,
// then creates and pushes the tag. It runs no tests: the Release workflow does.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`)
}

function fail(message) {
  console.error(`release:tag: ${message}`)
  process.exit(1)
}

git('checkout', 'main')
git('pull', '--ff-only', 'origin', 'main')

const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const tag = `v${version}`
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
if (!changelog.split('\n').some(line => line.startsWith(`## [${version}]`))) fail(`CHANGELOG.md has no section for ${version}`)
if (!existsSync(resolve(root, `docs/releases/${tag}.md`))) fail(`docs/releases/${tag}.md is missing`)

git('tag', tag)
git('push', 'origin', tag)
console.log(`Pushed ${tag}. Follow the Release run in GitHub Actions.`)

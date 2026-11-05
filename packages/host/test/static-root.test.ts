import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { firstExistingDir } from '../src/static.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

it('takes the first root that exists, and the preferred one when none does', async () => {
  const missingBundled = join(await tempDir('tnega-webroot-'), 'dist', 'web')
  const missingCheckout = join(await tempDir('tnega-webroot-'), 'dist', 'web')
  const webApp = await tempDir('tnega-webroot-app-')

  // A checkout where only the web app was built: the third candidate serves it.
  expect(firstExistingDir([missingBundled, missingCheckout, webApp])).toBe(webApp)
  // A bundled install wins over it.
  const bundled = await tempDir('tnega-webroot-bundled-')
  expect(firstExistingDir([bundled, missingCheckout, webApp])).toBe(bundled)
  // Nothing built yet: the source-checkout path is still reported, so the 404 it
  // produces names a path the person can build into.
  expect(firstExistingDir([missingBundled, missingCheckout])).toBe(missingCheckout)
})

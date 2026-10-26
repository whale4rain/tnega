import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSystemConfig } from '@tnega/config'
import { startWebServer } from '@tnega/host'

it('saves command network rules, names a bad rule, and clears them again', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-command-network-'))
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model' }))
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}${path}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  try {
    expect(await (await call('/api/config')).json()).toMatchObject({ sandbox: { network: { mode: 'open', allowedDomains: [], deniedDomains: [] } } })

    const bad = await call('/api/config', 'PUT', { sandbox: { network: { mode: 'allowlist', allowedDomains: ['github.com', 'https://x.dev/'] } } })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toContain('allowedDomains has entries that are not domains: "https://x.dev/"')
    expect((await call('/api/config', 'PUT', { sandbox: { network: { mode: 'wide' } } })).status).toBe(400)

    const saved = await call('/api/config', 'PUT', { sandbox: { network: { mode: 'allowlist', allowedDomains: ['GitHub.com', '*.github.com'], deniedDomains: ['gist.github.com'] } } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ sandbox: { network: { mode: 'allowlist', allowedDomains: ['github.com', '*.github.com'], deniedDomains: ['gist.github.com'] } } })
    expect((await readSystemConfig(configFile)).sandbox?.network?.mode).toBe('allowlist')

    // Open with no rules is the default, so the section disappears from the file.
    expect((await call('/api/config', 'PUT', { sandbox: { network: { mode: 'open', allowedDomains: [], deniedDomains: [] } } })).status).toBe(200)
    expect((await readSystemConfig(configFile)).sandbox).toBeUndefined()

    const support = await (await call('/api/sandbox/network')).json() as { filtering: unknown }
    expect(typeof support.filtering).toBe('boolean')
  } finally {
    await server.close()
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30_000)

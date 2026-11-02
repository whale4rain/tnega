import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSystemConfig } from '@tnega/config'
import { startWebServer } from '@tnega/host'

it('saves how computer use asks and the app tiers, and clears the tiers with an empty list', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-computer-settings-'))
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }))
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const call = (method = 'GET', body?: unknown) => fetch(`${server.url}/api/config?workspace=${encodeURIComponent(workspace)}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  try {
    // All-allow is the default: no per-app prompt, every app full.
    expect(await (await call()).json()).toMatchObject({ config: { computerApproval: 'auto', computerApps: {} } })
    expect((await call('PUT', { computerApproval: 'always' })).status).toBe(400)
    expect((await call('PUT', { computerApps: ['Notepad'] })).status).toBe(400)
    const saved = await call('PUT', { computerApproval: 'per-app', computerApps: { Notepad: 'look', Chrome: 'click', Paint: 'everything' } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ config: { computerApproval: 'per-app', computerApps: { Notepad: 'look', Chrome: 'click' } } })
    expect((await readSystemConfig(configFile)).computerApps).toEqual({ Notepad: 'look', Chrome: 'click' })
    expect((await call('PUT', { computerApps: {} })).status).toBe(200)
    expect((await readSystemConfig(configFile)).computerApps).toBeUndefined()
  } finally {
    await server.close()
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

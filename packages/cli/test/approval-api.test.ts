import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startWebServer } from '../src/server.js'
import { readSystemConfig } from '../src/config.js'

it('isolates reviewer credentials across provider switches and persists approval mode independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-approval-api-'))
  const configFile = join(dir, 'config.json')
  const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
  const api = async (path: string, method: string, body: unknown): Promise<Response> => await fetch(`${server.url}${path}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const initial = await api('/api/config', 'PUT', { approvalReview: { provider: 'jev', apiKey: 'jev-secret', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest' } })
    expect(initial.status).toBe(200)
    expect(await initial.text()).not.toContain('jev-secret')
    const switched = await api('/api/config', 'PUT', { approvalReview: { provider: 'openai', model: 'gpt-6.1-sol' } })
    expect(switched.status).toBe(200)
    expect((await readSystemConfig(configFile)).approvalReview).toEqual({ provider: 'openai', model: 'gpt-6.1-sol' })
    const query = `?workspace=${encodeURIComponent(dir)}`
    const created = await api(`/api/sessions${query}`, 'POST', {})
    const payload: unknown = await created.json()
    const id = Reflect.get(Reflect.get(Object(payload), 'session'), 'id')
    expect(typeof id).toBe('string')
    const changed = await api(`/api/sessions/${String(id)}${query}`, 'PATCH', { approvalMode: 'auto' })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ summary: { approvalMode: 'auto', permission: 'read-only' } })
    const manual = await api(`/api/sessions/${String(id)}${query}`, 'PATCH', { approvalMode: 'manual' })
    expect(manual.status).toBe(200)
    expect(await manual.json()).toMatchObject({ summary: { approvalMode: 'manual', permission: 'read-only' } })
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})


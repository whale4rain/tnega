import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())
it.each([undefined, false])('rejects a successful HTTP response that did not save CodeMode (%s)', async saved => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ config: { codeMode: saved } })))
  await expect(api.saveConfig({ codeMode: true })).rejects.toThrow(/CodeMode/)
})
it.each([true, false])('accepts the confirmed CodeMode state %s', async saved => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ config: { codeMode: saved } })))
  expect(await api.saveConfig({ codeMode: saved })).toMatchObject({ config: { codeMode: saved } })
})

it('discovers with a saved route without sending saved credentials', async () => {
  const fetch = vi.fn(async () => Response.json({ models: [], source: 'provider' }))
  vi.stubGlobal('fetch', fetch)
  await expect(api.discoverModels({ routeId: 'signed-in' })).resolves.toEqual({ models: [], source: 'provider' })
  expect(fetch).toHaveBeenCalledWith('/api/config/models/discover', expect.objectContaining({ method: 'POST', body: JSON.stringify({ routeId: 'signed-in' }) }))
})

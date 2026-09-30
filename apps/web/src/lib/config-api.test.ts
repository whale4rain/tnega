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

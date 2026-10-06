import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { api } from './api'
import { startWebServer } from '../../../../packages/cli/src/server.js'

it('starts ChatGPT sign-in from the web client while preserving API request guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-chatgpt-web-'))
  const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile: join(dir, 'config.json') })
  const nativeFetch = fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    nativeFetch(typeof input === 'string' && input.startsWith('/') ? `${server.url}${input}` : input, init))
  try {
    const missingClient = await nativeFetch(`${server.url}/api/auth/chatgpt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(missingClient.status).toBe(403)
    const missingJson = await nativeFetch(`${server.url}/api/auth/chatgpt`, {
      method: 'POST', headers: { 'x-tnega-client': '1' },
    })
    expect(missingJson.status).toBe(415)

    const { url } = await api.startChatgptLogin()
    expect(new URL(url).origin).toBe('https://auth.openai.com')
    expect(await api.chatgptLogin()).toEqual({ status: 'pending', url })
    expect(await api.signOutChatgpt()).toEqual({ status: 'signed-out' })
  } finally {
    vi.unstubAllGlobals()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

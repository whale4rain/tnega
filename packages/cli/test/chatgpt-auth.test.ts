import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeUrl, chatgptHeaders, ChatGptLogin, CHATGPT_CLIENT_ID, jwtClaims, pkcePair, tokensFrom } from '../src/chatgpt-auth.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const idToken = jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } })

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-chatgpt-'))
  dirs.push(dir)
  return join(dir, 'auth', 'chatgpt.json')
}

describe('ChatGPT sign-in', () => {
  it('builds a PKCE authorize URL like the Codex CLI', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[\w-]{43}$/)
    const url = new URL(authorizeUrl(challenge, 'state-1'))
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CHATGPT_CLIENT_ID, redirect_uri: 'http://localhost:1455/auth/callback', code_challenge: challenge,
      code_challenge_method: 'S256', scope: 'openid profile email offline_access', state: 'state-1',
    })
  })

  it('reads the account and expiry out of the tokens', () => {
    const tokens = tokensFrom({ access_token: jwt({ exp: 2_000_000_000 }), refresh_token: 'r1', id_token: idToken })
    expect(tokens).toMatchObject({ refreshToken: 'r1', accountId: 'acct_1', email: 'me@example.com', expiresAt: 2_000_000_000_000 })
    expect(jwtClaims('not-a-jwt')).toEqual({})
    // A refresh response without a new refresh or id token keeps the old ones.
    expect(tokensFrom({ access_token: 'a2', expires_in: 60 }, tokens)).toMatchObject({ accessToken: 'a2', refreshToken: 'r1', accountId: 'acct_1' })
  })

  it('signs requests with the account and refreshes an expiring token once', async () => {
    const file = await tempFile()
    await (await import('node:fs/promises')).mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify({ accessToken: 'old', refreshToken: 'r1', accountId: 'acct_1', expiresAt: 1_000 }))
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: CHATGPT_CLIENT_ID })
      return Response.json({ access_token: jwt({ exp: 9_999_999_999 }), refresh_token: 'r2' })
    })
    const headers = chatgptHeaders({ file, fetch: fetchMock as unknown as typeof fetch, now: () => 0 })
    const [first, second] = await Promise.all([headers(), headers()])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ 'chatgpt-account-id': 'acct_1', originator: 'codex_cli_rs' })
    expect(first.authorization).toBe(second.authorization)
    expect(first.authorization).not.toBe('Bearer old')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ refreshToken: 'r2', accountId: 'acct_1' })
    await expect(chatgptHeaders({ file: join(file, '..', 'missing.json') })()).rejects.toThrow(/Not signed in to ChatGPT/)
  })

  it('completes a sign-in through the local callback and stores the tokens privately', async () => {
    const file = await tempFile()
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    const onSignedIn = vi.fn()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: CHATGPT_CLIENT_ID })
      expect(form.get('code_verifier')).toMatch(/^[\w-]{43}$/)
      return Response.json({ access_token: jwt({ exp: 9_999_999_999 }), refresh_token: 'r1', id_token: idToken })
    })
    const login = new ChatGptLogin({ file, port, fetch: fetchMock as unknown as typeof fetch, onSignedIn })
    try {
      const { url } = await login.start()
      expect(await login.state()).toMatchObject({ status: 'pending' })
      const state = new URL(url).searchParams.get('state')!
      const bad = await fetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=wrong`)
      expect(bad.status).toBe(400)
      expect(await login.state()).toMatchObject({ status: 'error', message: expect.stringContaining('did not match') })

      const again = new URL((await login.start()).url).searchParams.get('state')!
      expect(again).not.toBe(state)
      const done = await fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${again}`)
      expect(await done.text()).toContain('Signed in to ChatGPT')
      expect(await login.state()).toEqual({ status: 'signed-in', email: 'me@example.com' })
      expect(onSignedIn).toHaveBeenCalledOnce()
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
      await login.signOut()
      expect(await login.state()).toEqual({ status: 'signed-out' })
    } finally {
      await login.stop()
    }
  })
})

it('routes a ChatGPT model to the Codex backend and counts the sign-in as its credential', async () => {
  const { effectiveLlmConfig, effectiveApiKey } = await import('../src/config.js')
  const { chatgptAuthFile, llmAuthOptions } = await import('../src/chatgpt-auth.js')
  const config = { model: 'chatgpt', models: [{ id: 'chatgpt', model: 'gpt-5-codex', auth: 'chatgpt' as const }] }
  await rm(chatgptAuthFile(), { force: true })
  expect(effectiveLlmConfig(config)).toMatchObject({ baseUrl: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5-codex', auth: 'chatgpt', apiKeySet: false })
  await (await import('node:fs/promises')).mkdir(join(chatgptAuthFile(), '..'), { recursive: true })
  await writeFile(chatgptAuthFile(), JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  try {
    expect(effectiveLlmConfig(config).apiKeySet).toBe(true)
    expect(effectiveApiKey(config, {}, 'chatgpt')).toBe('chatgpt-sign-in')
    expect(llmAuthOptions(effectiveLlmConfig(config))).toMatchObject({ protocol: 'responses' })
    expect(llmAuthOptions({})).toEqual({})
  } finally {
    await rm(chatgptAuthFile(), { force: true })
  }
})

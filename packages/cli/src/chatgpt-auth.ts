import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { localExecutionProvider, networkFetch } from '@tnega/execution'
import type { LlmConfig } from '@tnega/llm'
import { resolveTnegaHome } from './home-paths.js'

/**
 * Sign in with a ChatGPT account, the way the Codex CLI does: OAuth 2.0 with
 * PKCE against auth.openai.com, a one-shot callback server on
 * localhost:1455, and requests to the Codex backend
 * (chatgpt.com/backend-api/codex/responses, the Responses API) with the
 * account's access token. Usage counts against the ChatGPT plan, not an API
 * key. Tokens are kept in `~/.tnega/auth/chatgpt.json` (owner-only) and
 * refreshed before they expire.
 */
export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CHATGPT_CALLBACK_PORT = 1455
export const CHATGPT_REDIRECT_URI = `http://localhost:${CHATGPT_CALLBACK_PORT}/auth/callback`
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
/** Stands in for an API key on routes that use the ChatGPT sign-in. */
export const CHATGPT_SIGNED_IN = 'chatgpt-sign-in'

export interface ChatGptTokens {
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  email?: string
  /** Epoch milliseconds when the access token expires. */
  expiresAt?: number
}

export type ChatGptLoginState =
  | { status: 'signed-out' }
  | { status: 'pending'; url: string }
  | { status: 'signed-in'; email?: string }
  | { status: 'error'; message: string }

export function chatgptAuthFile(): string {
  return join(resolveTnegaHome(), 'auth', 'chatgpt.json')
}

export function isChatgptSignedIn(file = chatgptAuthFile()): boolean {
  return existsSync(file)
}

/** The JSON payload of a JWT, without verifying it (the issuer is trusted over TLS). */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split('.')[1]
  if (!payload) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Fold a token response into stored tokens, keeping what the response leaves out. */
export function tokensFrom(response: Record<string, unknown>, previous?: ChatGptTokens): ChatGptTokens {
  const accessToken = typeof response.access_token === 'string' ? response.access_token : previous?.accessToken
  const refreshToken = typeof response.refresh_token === 'string' ? response.refresh_token : previous?.refreshToken
  if (!accessToken || !refreshToken) throw new Error('ChatGPT sign-in returned no tokens')
  const idToken = typeof response.id_token === 'string' ? response.id_token : previous?.idToken
  const idClaims = jwtClaims(idToken)
  const auth = idClaims['https://api.openai.com/auth']
  const accountId = auth && typeof auth === 'object' && typeof (auth as Record<string, unknown>).chatgpt_account_id === 'string'
    ? (auth as Record<string, string>).chatgpt_account_id : previous?.accountId
  const email = typeof idClaims.email === 'string' ? idClaims.email : previous?.email
  const exp = jwtClaims(accessToken).exp
  const expiresIn = typeof response.expires_in === 'number' ? response.expires_in : undefined
  const expiresAt = typeof exp === 'number' ? exp * 1000 : expiresIn !== undefined ? Date.now() + expiresIn * 1000 : previous?.expiresAt
  return {
    accessToken, refreshToken,
    ...(idToken ? { idToken } : {}), ...(accountId ? { accountId } : {}), ...(email ? { email } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

export async function readChatgptTokens(file = chatgptAuthFile()): Promise<ChatGptTokens | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const record = parsed as Record<string, unknown>
    return typeof record.accessToken === 'string' && typeof record.refreshToken === 'string' ? record as unknown as ChatGptTokens : undefined
  } catch {
    return undefined
  }
}

async function writeChatgptTokens(tokens: ChatGptTokens, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
}

/** Keep OAuth and Responses on the same configured network path as the host. */
const chatgptFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  return networkFetch(new URL(request.url), {
    method: request.method, headers: request.headers, signal: request.signal,
    redirect: request.redirect,
    ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
  })
}

async function tokenRequest(body: Record<string, string>, form: boolean, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${CHATGPT_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`ChatGPT token request failed (${response.status}): ${text.slice(0, 300)}`)
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') throw new Error('ChatGPT token response was not an object')
  return parsed as Record<string, unknown>
}

/**
 * Headers for a Codex backend request, refreshing the access token when it
 * expires within a minute. Concurrent callers share one refresh.
 */
export function chatgptHeaders(options: { file?: string; fetch?: typeof fetch; now?: () => number } = {}): (signal?: AbortSignal) => Promise<Record<string, string>> {
  const file = options.file ?? chatgptAuthFile()
  const fetchImpl = options.fetch ?? chatgptFetch
  const now = options.now ?? Date.now
  let refreshing: Promise<ChatGptTokens> | undefined
  return async signal => {
    let tokens = await readChatgptTokens(file)
    if (!tokens) throw new Error('Not signed in to ChatGPT. Sign in again from Settings → Models.')
    if (tokens.expiresAt !== undefined && tokens.expiresAt - now() < 60_000) {
      const current = tokens
      refreshing ??= tokenRequest({
        client_id: CHATGPT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: current.refreshToken, scope: 'openid profile email',
      }, false, fetchImpl, signal).then(async response => {
        const next = tokensFrom(response, current)
        await writeChatgptTokens(next, file)
        return next
      }).finally(() => { refreshing = undefined })
      try {
        tokens = await refreshing
      } catch (error) {
        throw new Error(`ChatGPT session expired and could not be refreshed; sign in again from Settings → Models. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
    return {
      authorization: `Bearer ${tokens.accessToken}`,
      ...(tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}),
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
    }
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'codex_cli_rs',
  })
  return `${CHATGPT_ISSUER}/oauth/authorize?${params.toString()}`
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:4rem auto;max-width:28rem;text-align:center"><h2>${title}</h2><p>${body}</p></body>`

/**
 * One sign-in at a time: `start` opens the callback server and returns the
 * URL to open in a browser; the callback exchanges the code and stores the
 * tokens. `state()` reports progress for the Settings page to poll.
 */
export class ChatGptLogin {
  private current: ChatGptLoginState = { status: 'signed-out' }
  private server: Server | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: { file?: string; fetch?: typeof fetch; port?: number; onSignedIn?: () => Promise<void> | void } = {}) {}

  private get file(): string {
    return this.options.file ?? chatgptAuthFile()
  }

  async state(): Promise<ChatGptLoginState> {
    if (this.current.status === 'pending' || this.current.status === 'error') return this.current
    const tokens = await readChatgptTokens(this.file)
    return tokens ? { status: 'signed-in', ...(tokens.email ? { email: tokens.email } : {}) } : { status: 'signed-out' }
  }

  async start(): Promise<{ url: string }> {
    await this.stop()
    const { verifier, challenge } = pkcePair()
    const state = base64url(randomBytes(24))
    const url = authorizeUrl(challenge, state)
    const fetchImpl = this.options.fetch ?? chatgptFetch
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', CHATGPT_REDIRECT_URI)
      if (requestUrl.pathname !== '/auth/callback') { res.writeHead(404).end(); return }
      const finish = (status: number, title: string, body: string): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(title, body))
        void this.stop()
      }
      const error = requestUrl.searchParams.get('error')
      if (error) {
        this.current = { status: 'error', message: requestUrl.searchParams.get('error_description') ?? error }
        finish(400, 'Sign-in was not completed', 'Return to Tnega and try again.')
        return
      }
      const code = requestUrl.searchParams.get('code')
      if (!code || requestUrl.searchParams.get('state') !== state) {
        this.current = { status: 'error', message: 'The sign-in response did not match this request.' }
        finish(400, 'Sign-in was not completed', 'The response did not match. Return to Tnega and try again.')
        return
      }
      void tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: CHATGPT_REDIRECT_URI, client_id: CHATGPT_CLIENT_ID, code_verifier: verifier,
      }, true, fetchImpl).then(async response => {
        await writeChatgptTokens(tokensFrom(response), this.file)
        this.current = { status: 'signed-out' }
        await this.options.onSignedIn?.()
        finish(200, 'Signed in to ChatGPT', 'You can close this tab and return to Tnega.')
      }, (reason: unknown) => {
        this.current = { status: 'error', message: reason instanceof Error ? reason.message : String(reason) }
        finish(500, 'Sign-in failed', 'Return to Tnega and try again.')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', error => reject(Object.assign(new Error(`Could not listen on localhost:${this.options.port ?? CHATGPT_CALLBACK_PORT} for the sign-in callback (${(error as NodeJS.ErrnoException).code ?? error.message}). Close other Codex or Tnega sign-ins and try again.`), { cause: error })))
      server.listen(this.options.port ?? CHATGPT_CALLBACK_PORT, '127.0.0.1', () => resolve())
    })
    this.server = server
    this.current = { status: 'pending', url }
    this.timer = setTimeout(() => {
      this.current = { status: 'error', message: 'Sign-in timed out after 10 minutes.' }
      void this.stop()
    }, 10 * 60_000)
    return { url }
  }

  async signOut(): Promise<void> {
    await this.stop()
    this.current = { status: 'signed-out' }
    await rm(this.file, { force: true })
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const server = this.server
    this.server = undefined
    if (this.current.status === 'pending') this.current = { status: 'signed-out' }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

let sharedHeaders: ReturnType<typeof chatgptHeaders> | undefined

/**
 * The Codex backend has, at times, accepted only the Codex CLI's own prompt
 * as `instructions`. Fetched from the open-source Codex repository the first
 * time the backend asks for it, and cached.
 */
export const CODEX_INSTRUCTIONS_URL = 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/prompt.md'

async function codexInstructions(): Promise<string> {
  const cache = join(resolveTnegaHome(), 'auth', 'codex-instructions.md')
  try {
    const cached = await readFile(cache, 'utf8')
    if (cached.trim()) return cached
  } catch {
    // Not cached yet.
  }
  const response = await localExecutionProvider.fetchHttp({ url: CODEX_INSTRUCTIONS_URL, maxBytes: 512 * 1024 })
  if (!response.ok || response.truncated || !response.body.trim()) throw new Error(`could not load the Codex instructions (${response.status})`)
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, response.body)
  return response.body
}

/** Adapter settings for a route that signs in with ChatGPT; nothing for other routes. */
export function llmAuthOptions(effective: { auth?: 'chatgpt' }): Partial<LlmConfig> {
  if (effective.auth !== 'chatgpt') return {}
  sharedHeaders ??= chatgptHeaders()
  // The ChatGPT Codex backend rejects temperature even when reasoning is unset.
  return { protocol: 'responses', temperature: undefined, fetch: chatgptFetch, requestHeaders: sharedHeaders, fallbackInstructions: codexInstructions }
}

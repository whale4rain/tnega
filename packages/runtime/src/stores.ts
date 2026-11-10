import type { Context, Plugin } from '@tnega/core'
import { blobsLocal } from '@tnega/blobs-local'
import { sessionStoreJsonl } from '@tnega/session-store-jsonl'
import { LOCAL_ACCOUNT_ID, sessionStorePg } from '@tnega/session-store-pg'
import { SecretVault } from '@tnega/secrets-local'
import { openPgRememberedSecrets, parseMasterKey } from '@tnega/secrets-pg'

/** Where a host keeps Sessions: JSONL files under the tnega home, or a Postgres database. */
export type SessionStoreSpec =
  | { kind: 'jsonl' }
  | { kind: 'postgres'; url: string }

export interface StateCapabilitySpec {
  sessions: SessionStoreSpec
  /**
   * Remembered secrets sealed with this master key in the same database
   * (AES-256-GCM). Only with a Postgres store; without it they stay in the
   * owner-only file under the tnega home.
   */
  masterKey?: Buffer
}

/**
 * The store a host's environment asks for. `TNEGA_SESSION_STORE=postgres`
 * with `DATABASE_URL` puts Sessions on Postgres; unset (or `jsonl`) keeps
 * them in files. Anything else is refused, never quietly a file store.
 */
export function stateSpecFromEnv(env: NodeJS.ProcessEnv = process.env): StateCapabilitySpec {
  const kind = env.TNEGA_SESSION_STORE?.trim().toLowerCase() || 'jsonl'
  if (kind === 'jsonl') return { sessions: { kind: 'jsonl' } }
  if (kind === 'postgres' || kind === 'pg') {
    const url = env.DATABASE_URL?.trim()
    if (!url) throw new Error('TNEGA_SESSION_STORE=postgres needs DATABASE_URL')
    const masterKey = env.TNEGA_MASTER_KEY?.trim()
    return { sessions: { kind: 'postgres', url }, ...(masterKey ? { masterKey: parseMasterKey(masterKey) } : {}) }
  }
  throw new Error(`unknown TNEGA_SESSION_STORE: ${env.TNEGA_SESSION_STORE}; use jsonl or postgres`)
}

/**
 * State seam of a host: image bytes in the local blob store, then the
 * Session store the spec names, on `ctx.blobs` and `ctx.sessionStore`.
 */
export const stateCapability: Plugin = {
  name: 'capability:state',
  async apply(ctx: Context, spec: StateCapabilitySpec) {
    // Image bytes live once under the tnega home; Sessions keep their hashes.
    await ctx.plugin(blobsLocal)
    if (spec.sessions.kind === 'postgres') await ctx.plugin(sessionStorePg, { url: spec.sessions.url })
    else await ctx.plugin(sessionStoreJsonl)
  },
}

/**
 * The host's secret vault for a state spec: remembered secrets sealed in
 * Postgres when the spec has a database and a master key, otherwise in the
 * owner-only file. `close` lets go of the database.
 */
export async function openSecretVault(spec: StateCapabilitySpec): Promise<{ vault: SecretVault; close(): Promise<void> }> {
  if (spec.sessions.kind !== 'postgres' || !spec.masterKey) return { vault: new SecretVault(), close: async () => {} }
  const remembered = await openPgRememberedSecrets({ url: spec.sessions.url, masterKey: spec.masterKey, accountId: LOCAL_ACCOUNT_ID })
  return { vault: new SecretVault({ remembered }), close: () => remembered.close() }
}

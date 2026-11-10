import type { Context, Plugin } from '@tnega/core'
import { blobsLocal } from '@tnega/blobs-local'
import { sessionStoreJsonl } from '@tnega/session-store-jsonl'
import { sessionStorePg } from '@tnega/session-store-pg'

/** Where a host keeps Sessions: JSONL files under the tnega home, or a Postgres database. */
export type SessionStoreSpec =
  | { kind: 'jsonl' }
  | { kind: 'postgres'; url: string }

export interface StateCapabilitySpec {
  sessions: SessionStoreSpec
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
    return { sessions: { kind: 'postgres', url } }
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

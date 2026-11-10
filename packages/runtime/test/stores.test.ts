import { describe, expect, it } from 'vitest'
import { stateSpecFromEnv } from '../src/index.js'

describe('picking the Session store from the environment', () => {
  it('keeps Sessions in files unless asked otherwise', () => {
    expect(stateSpecFromEnv({})).toEqual({ sessions: { kind: 'jsonl' } })
    expect(stateSpecFromEnv({ TNEGA_SESSION_STORE: 'jsonl' })).toEqual({ sessions: { kind: 'jsonl' } })
  })

  it('puts Sessions on Postgres with a database URL', () => {
    expect(stateSpecFromEnv({ TNEGA_SESSION_STORE: 'postgres', DATABASE_URL: 'postgresql://db/tnega' }))
      .toEqual({ sessions: { kind: 'postgres', url: 'postgresql://db/tnega' } })
  })

  it('refuses Postgres without a URL, and a store it does not know, instead of falling back to files', () => {
    expect(() => stateSpecFromEnv({ TNEGA_SESSION_STORE: 'postgres' })).toThrow(/DATABASE_URL/)
    expect(() => stateSpecFromEnv({ TNEGA_SESSION_STORE: 'mysql' })).toThrow(/unknown TNEGA_SESSION_STORE/)
  })
})

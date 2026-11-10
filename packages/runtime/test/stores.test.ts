import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { memberLoginOf, stateSpecFromEnv } from '../src/index.js'

describe('picking the Session store from the environment', () => {
  it('keeps Sessions in files unless asked otherwise', () => {
    expect(stateSpecFromEnv({})).toEqual({ sessions: { kind: 'jsonl' } })
    expect(stateSpecFromEnv({ TNEGA_SESSION_STORE: 'jsonl' })).toEqual({ sessions: { kind: 'jsonl' } })
  })

  it('puts Sessions on Postgres with a database URL', () => {
    expect(stateSpecFromEnv({ TNEGA_SESSION_STORE: 'postgres', DATABASE_URL: 'postgresql://db/tnega' }))
      .toEqual({ sessions: { kind: 'postgres', url: 'postgresql://db/tnega' } })
  })

  it('seals remembered secrets with the master key only on Postgres, and refuses a malformed key', () => {
    const key = Buffer.alloc(32, 7)
    expect(stateSpecFromEnv({ TNEGA_SESSION_STORE: 'postgres', DATABASE_URL: 'postgresql://db/tnega', TNEGA_MASTER_KEY: key.toString('base64') }).masterKey).toEqual(key)
    expect(stateSpecFromEnv({ TNEGA_MASTER_KEY: key.toString('base64') }).masterKey).toBeUndefined()
    expect(() => stateSpecFromEnv({ TNEGA_SESSION_STORE: 'postgres', DATABASE_URL: 'postgresql://db/tnega', TNEGA_MASTER_KEY: 'short' })).toThrow(/32 bytes/)
  })

  it('refuses Postgres without a URL, and a store it does not know, instead of falling back to files', () => {
    expect(() => stateSpecFromEnv({ TNEGA_SESSION_STORE: 'postgres' })).toThrow(/DATABASE_URL/)
    expect(() => stateSpecFromEnv({ TNEGA_SESSION_STORE: 'mysql' })).toThrow(/unknown TNEGA_SESSION_STORE/)
  })
})

describe('whose folder a Session is in', () => {
  it('names the member whose own folder holds the path, and nobody outside it', () => {
    const root = join('/srv', 'tnega', 'members')
    expect(memberLoginOf(root, join(root, 'mia'))).toBe('mia')
    expect(memberLoginOf(root, join(root, 'mia', 'app', 'src'))).toBe('mia')
    expect(memberLoginOf(root, root)).toBeUndefined()
    expect(memberLoginOf(root, join(root, '..', 'other'))).toBeUndefined()
    expect(memberLoginOf(root, join('/home', 'mia'))).toBeUndefined()
  })
})

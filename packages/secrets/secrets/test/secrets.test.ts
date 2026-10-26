import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  createStreamMasker,
  maskSecrets,
  maskSecretsDeep,
  secretEnv,
  secretNameProblem,
  SecretStore,
  type SecretEntry,
  type SecretInfo,
} from '../src/index.js'

const TOKEN = { name: 'GITHUB_TOKEN', value: 'ghp_abcdefghijklmnop1234' }

describe('secret names', () => {
  it('accepts environment variable names', () => {
    expect(secretNameProblem('GITHUB_TOKEN')).toBeUndefined()
    expect(secretNameProblem('_api_key2')).toBeUndefined()
  })

  it('refuses names that are not variables or that commands rely on', () => {
    expect(secretNameProblem('2FA')).toMatch(/environment variable/)
    expect(secretNameProblem('MY-KEY')).toMatch(/environment variable/)
    expect(secretNameProblem('')).toMatch(/environment variable/)
    expect(secretNameProblem('PATH')).toMatch(/rely on/)
    expect(secretNameProblem('ld_preload')).toMatch(/rely on/)
    expect(secretNameProblem('TNEGA_SHELL')).toMatch(/reserved/)
  })

  it('refuses the families whose variables decide what a command loads or runs', () => {
    for (const name of [
      'LD_AUDIT', 'DYLD_FRAMEWORK_PATH', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_SCRIPT_SHELL',
      'JAVA_TOOL_OPTIONS', 'JAVA_HOME', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_SYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
    ]) expect(secretNameProblem(name), name).toMatch(/rely on/)
    // Only the Git variables that control execution; a token name is ordinary.
    expect(secretNameProblem('GIT_TOKEN')).toBeUndefined()
    expect(secretNameProblem('NPM_TOKEN')).toBeUndefined()
  })
})

describe('masking', () => {
  it('replaces a value and its common encodings with the name', () => {
    const base64 = Buffer.from(TOKEN.value).toString('base64')
    const text = `token=${TOKEN.value}\nb64=${base64}\nurl=${encodeURIComponent(TOKEN.value)}`
    const masked = maskSecrets(text, [TOKEN])
    expect(masked).not.toContain(TOKEN.value)
    expect(masked).not.toContain(base64.replace(/=+$/, ''))
    expect(masked).toBe('token=[secret: GITHUB_TOKEN]\nb64=[secret: GITHUB_TOKEN]\nurl=[secret: GITHUB_TOKEN]')
  })

  it('leaves very short values alone', () => {
    expect(maskSecrets('a b c abc', [{ name: 'SHORT', value: 'abc' }])).toBe('a b c abc')
  })

  it('masks strings anywhere inside structured output', () => {
    const output = { stdout: `hi ${TOKEN.value}`, lines: [TOKEN.value], exitCode: 0 }
    expect(maskSecretsDeep(output, [TOKEN])).toEqual({ stdout: 'hi [secret: GITHUB_TOKEN]', lines: ['[secret: GITHUB_TOKEN]'], exitCode: 0 })
  })

  it('turns entries into environment variables', () => {
    expect(secretEnv([TOKEN, { name: 'B', value: 'x' }])).toEqual({ GITHUB_TOKEN: TOKEN.value, B: 'x' })
  })
})

describe('values handed to a command', () => {
  class MemoryStore extends SecretStore {
    values = new Map<string, string>()
    override async set(name: string, value: string): Promise<SecretInfo> { this.values.set(name, value); return { name, remembered: false } }
    override async remove(name: string) { return this.values.delete(name) }
    override async list(): Promise<SecretInfo[]> { return [...this.values.keys()].map(name => ({ name, remembered: false })) }
    override async entries(): Promise<SecretEntry[]> { return [...this.values].map(([name, value]) => ({ name, value })) }
  }

  it('stay maskable after the secret is removed', async () => {
    const store = new MemoryStore(new Context())
    await store.set(TOKEN.name, TOKEN.value)
    expect(await store.maskingEntries()).toEqual([TOKEN])
    store.noteInjected(await store.entries())
    await store.remove(TOKEN.name)
    expect(await store.maskingEntries()).toEqual([TOKEN])
    expect(maskSecrets(`token ${TOKEN.value}`, await store.maskingEntries())).toBe('token [secret: GITHUB_TOKEN]')
  })

  it('prefer the value the store holds now', async () => {
    const store = new MemoryStore(new Context())
    store.noteInjected([{ name: TOKEN.name, value: 'old-value-0000' }])
    await store.set(TOKEN.name, TOKEN.value)
    expect(await store.maskingEntries()).toEqual([TOKEN])
    await store.set('OTHER', 'later-0000')
    expect((await store.maskingEntries()).map(entry => entry.name)).toEqual(['GITHUB_TOKEN', 'OTHER'])
  })
})

describe('stream masking', () => {
  it('masks a value split across pieces', () => {
    const masker = createStreamMasker([TOKEN])
    const pieces = ['start ', TOKEN.value.slice(0, 7), TOKEN.value.slice(7, 15), `${TOKEN.value.slice(15)} end`]
    const shown = pieces.map(piece => masker.push(piece)).join('') + masker.flush()
    expect(shown).toBe('start [secret: GITHUB_TOKEN] end')
    expect(shown).not.toContain(TOKEN.value.slice(0, 7))
  })

  it('releases a held-back tail that turns out not to be a value', () => {
    const masker = createStreamMasker([TOKEN])
    expect(masker.push('see ghp_')).toBe('see ')
    expect(masker.push('nothing!')).toBe('ghp_nothing!')
    expect(masker.flush()).toBe('')
  })

  it('masks a repeated prefix pattern that straddles a piece boundary', () => {
    const masker = createStreamMasker([{ name: 'K', value: 'abababab' }])
    const shown = masker.push('xabab') + masker.push('abab!') + masker.flush()
    expect(shown).toBe('x[secret: K]!')
  })
})

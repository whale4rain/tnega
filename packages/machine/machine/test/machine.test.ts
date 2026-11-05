import { describe, expect, it } from 'vitest'
import { boxEnvironment, egressAuthorization, validateBoxSpec, type BoxSpec } from '../src/index.js'

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'

function spec(overrides: Partial<BoxSpec> = {}): BoxSpec {
  return {
    template: 'tnega-box',
    daemon: { serverUrl: 'wss://tnega.example.com/daemon', token: 'daemon-token' },
    workspacePath: '/workspace',
    network: { mode: 'egress', egress: { proxyUrl: 'http://10.0.0.2:3128', proxyAddresses: ['10.0.0.2'], token: 'egress-token', caCertificate: CA } },
    ...overrides,
  }
}

describe('validateBoxSpec', () => {
  it('accepts a complete spec', () => {
    expect(() => validateBoxSpec(spec({ isolation: 'microvm', resources: { cpus: 2, memoryMb: 2048, pids: 512 } }))).not.toThrow()
  })

  it.each<[string, Partial<BoxSpec>, RegExp]>([
    ['no template', { template: ' ' }, /template/],
    ['an http server URL', { daemon: { serverUrl: 'https://x', token: 't' } }, /ws:\/\//],
    ['no daemon token', { daemon: { serverUrl: 'wss://x', token: '' } }, /daemon token/],
    ['a relative workspace', { workspacePath: 'workspace' }, /absolute/],
    ['a bad env name', { env: { 'A-B': '1' } }, /not a valid variable name/],
    ['egress without the proxy address', { network: { mode: 'egress', egress: { proxyUrl: 'http://10.0.0.2:3128', proxyAddresses: [], token: 't', caCertificate: CA } } }, /proxyAddresses/],
    ['egress without a CA', { network: { mode: 'egress', egress: { proxyUrl: 'http://10.0.0.2:3128', proxyAddresses: ['10.0.0.2'], token: 't', caCertificate: 'x' } } }, /PEM/],
    ['too little memory', { resources: { memoryMb: 64 } }, /memoryMb/],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => validateBoxSpec(spec(overrides))).toThrow(message)
  })
})

describe('boxEnvironment', () => {
  it('points every tool at the egress proxy with the box token, and the spec env cannot undo it', () => {
    const env = boxEnvironment(spec({ env: { HTTPS_PROXY: '', NO_PROXY: '*', LANG: 'C.UTF-8' } }))
    expect(env).toMatchObject({
      LANG: 'C.UTF-8',
      TNEGA_SERVER: 'wss://tnega.example.com/daemon',
      TNEGA_DAEMON_TOKEN: 'daemon-token',
      TNEGA_WORKSPACE: '/workspace',
      HTTPS_PROXY: 'http://box:egress-token@10.0.0.2:3128',
      https_proxy: 'http://box:egress-token@10.0.0.2:3128',
      NO_PROXY: '',
      TNEGA_EGRESS_CA: CA,
    })
  })

  it('sets no proxy for an open or a no-network box', () => {
    expect(boxEnvironment(spec({ network: { mode: 'open' } }))).not.toHaveProperty('HTTPS_PROXY')
    expect(boxEnvironment(spec({ network: { mode: 'none' } }))).not.toHaveProperty('TNEGA_EGRESS_CA')
  })

  it('encodes the egress token as the proxy expects', () => {
    expect(egressAuthorization('abc')).toBe(`Basic ${Buffer.from('box:abc').toString('base64')}`)
  })
})

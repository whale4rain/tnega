import { describe, expect, it } from 'vitest'
import type { ExecutionProvider, ShellRequest } from '@tnega/process'
import { approvalHash, parseEnvironment, resolveCredential, runSetup, secretNames } from '../src/index.js'

const FULL = `
version = 1

[resources]
cpus = 2
memory_mb = 4096

[setup]
script = """
pnpm install
"""
secrets = ["NPM_TOKEN"]
hosts = ["npm.pkg.github.com"]

[network]
allow = ["*.githubusercontent.com", "API.GitHub.com"]

[[network.credentials]]
host = "api.github.com"
header = "Authorization"
value = "Bearer \${GITHUB_TOKEN}"

[idle]
pause_after_minutes = 10
`

describe('parseEnvironment', () => {
  it('reads every section into the shape the server uses', () => {
    expect(parseEnvironment(FULL)).toEqual({
      resources: { cpus: 2, memoryMb: 4096 },
      setup: { script: 'pnpm install\n', secrets: ['NPM_TOKEN'], hosts: ['npm.pkg.github.com'] },
      network: {
        open: false,
        allow: ['*.githubusercontent.com', 'api.github.com'],
        credentials: [{ host: 'api.github.com', header: 'authorization', value: 'Bearer ${GITHUB_TOKEN}' }],
      },
      idle: { pauseAfterMinutes: 10 },
    })
  })

  it('gives an empty file the defaults: no setup, no hosts, pause after 5 minutes', () => {
    expect(parseEnvironment('')).toEqual({ resources: {}, network: { open: false, allow: [], credentials: [] }, idle: { pauseAfterMinutes: 5 } })
  })

  it.each([
    ['unknown key', '[network]\nalow = ["x.com"]', /unknown key network\.alow/],
    ['wildcard credential host', '[[network.credentials]]\nhost = "*.github.com"\nheader = "a"\nvalue = "${T}"', /one exact host/],
    ['credential with a literal key', '[[network.credentials]]\nhost = "api.github.com"\nheader = "a"\nvalue = "Bearer abc"', /must name a secret/],
    ['open box with keys', '[network]\nopen = true\nallow = ["x.com"]', /cannot be combined/],
    ['bad host', '[network]\nallow = ["https://x.com"]', /not a host name/],
    ['bad secret name', '[setup]\nscript = "x"\nsecrets = ["A-B"]', /not a variable name/],
    ['broken TOML', '[setup\nscript=', /not valid TOML/],
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseEnvironment(text)).toThrow(message)
  })
})

describe('approvalHash', () => {
  it('changes with the script, a secret or where a key goes, and not with resources or idle time', () => {
    const base = approvalHash(parseEnvironment(FULL))
    expect(approvalHash(parseEnvironment(FULL.replace('memory_mb = 4096', 'memory_mb = 8192').replace('= 10', '= 20')))).toBe(base)
    expect(approvalHash(parseEnvironment(FULL.replace('pnpm install', 'pnpm install && curl evil')))).not.toBe(base)
    expect(approvalHash(parseEnvironment(FULL.replace('"NPM_TOKEN"', '"NPM_TOKEN", "AWS_KEY"')))).not.toBe(base)
    expect(approvalHash(parseEnvironment(FULL.replace('host = "api.github.com"', 'host = "uploads.github.com"')))).not.toBe(base)
  })

  it('lists every secret the environment uses', () => {
    expect(secretNames(parseEnvironment(FULL))).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN'])
  })
})

describe('resolveCredential', () => {
  it('fills in the secret and refuses a missing one instead of sending an empty key', () => {
    const [credential] = parseEnvironment(FULL).network.credentials
    expect(resolveCredential(credential!, { GITHUB_TOKEN: 'ghp_1' })).toBe('Bearer ghp_1')
    expect(() => resolveCredential(credential!, {})).toThrow(/GITHUB_TOKEN/)
  })
})

describe('runSetup', () => {
  function fakeExecution(exitCode: number, output = ''): { execution: Pick<ExecutionProvider, 'runShell'>; calls: ShellRequest[] } {
    const calls: ShellRequest[] = []
    const execution = {
      runShell: async (request: ShellRequest) => { calls.push(request); return { exitCode, stdout: output, stderr: '' } },
    }
    return { execution, calls }
  }

  it('passes secrets and the setup proxy in that one command\'s environment', async () => {
    const { execution, calls } = fakeExecution(0)
    await runSetup(execution, { cwd: '/workspace', script: 'pnpm install', secrets: { NPM_TOKEN: 'npm_abc' }, proxyUrl: 'http://box:setup@10.0.0.2:3128' })
    expect(calls[0]).toMatchObject({ command: 'pnpm install', cwd: '/workspace', env: { NPM_TOKEN: 'npm_abc', HTTPS_PROXY: 'http://box:setup@10.0.0.2:3128' } })
  })

  it('fails with the output tail, secrets hidden', async () => {
    const { execution } = fakeExecution(1, 'auth failed for npm_abcdef\n')
    await expect(runSetup(execution, { cwd: '/w', script: 'x', secrets: { NPM_TOKEN: 'npm_abcdef' } }))
      .rejects.toMatchObject({ code: 'SETUP_FAILED', message: expect.stringContaining('auth failed for [secret]') })
  })
})

import { describe, expect, it } from 'vitest'
import type { ExecutionProvider, ShellRequest } from '@tnega/process'
import { approvalHash, egressCredentials, parseEnvironment, proxiedSecretNames, resolveCredential, runSetup, secretNames } from '../src/index.js'

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
    expect(approvalHash(parseEnvironment(`template = "other-image"\n${FULL}`))).not.toBe(base)
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
    await runSetup(execution, { cwd: '/workspace', script: 'pnpm install', secrets: { NPM_TOKEN: 'npm_abc123' }, proxyUrl: 'http://box:setup@10.0.0.2:3128' })
    expect(calls[0]).toMatchObject({ command: 'pnpm install', cwd: '/workspace', env: { NPM_TOKEN: 'npm_abc123', HTTPS_PROXY: 'http://box:setup@10.0.0.2:3128' } })
  })

  it('hides secrets in the result and in streamed output, even when a secret is split across chunks', async () => {
    const chunks: string[] = []
    const execution = {
      runShell: async (request: ShellRequest) => {
        request.onOutput?.(Buffer.from('token npm_ab'), 'stdout')
        request.onOutput?.(Buffer.from('cdef done\n'), 'stdout')
        return { exitCode: 0, stdout: 'token npm_abcdef done\n', stderr: '' }
      },
    }
    const result = await runSetup(execution, { cwd: '/w', script: 'x', secrets: { NPM_TOKEN: 'npm_abcdef' }, onOutput: chunk => chunks.push(chunk.toString()) })
    expect(result.stdout).toBe('token [secret] done\n')
    expect(chunks.join('')).toBe('token [secret] done\n')
  })

  it('refuses a secret too short to hide in the output', async () => {
    const { execution, calls } = fakeExecution(0)
    await expect(runSetup(execution, { cwd: '/w', script: 'x', secrets: { PIN: 'abc' } })).rejects.toMatchObject({ code: 'ENVIRONMENT_INVALID', message: expect.stringContaining('PIN') })
    expect(calls).toHaveLength(0)
  })

  it('refuses a secret with a NUL, and hides secrets in an error from a command that could not start', async () => {
    const { execution } = fakeExecution(0)
    await expect(runSetup(execution, { cwd: '/w', script: 'x', secrets: { TOKEN: 'abcdefgh\0tail' } })).rejects.toMatchObject({ code: 'ENVIRONMENT_INVALID', message: expect.not.stringContaining('abcdefgh') })
    const failing = { runShell: async (): Promise<never> => { throw new Error('spawn failed with TOKEN=npm_abcdef') } }
    await expect(runSetup(failing, { cwd: '/w', script: 'x', secrets: { TOKEN: 'npm_abcdef' } })).rejects.toMatchObject({ code: 'SETUP_FAILED', message: expect.stringContaining('TOKEN=[secret]') })
  })

  it('fails with the output tail, secrets hidden', async () => {
    const { execution } = fakeExecution(1, 'auth failed for npm_abcdef\n')
    await expect(runSetup(execution, { cwd: '/w', script: 'x', secrets: { NPM_TOKEN: 'npm_abcdef' } }))
      .rejects.toMatchObject({ code: 'SETUP_FAILED', message: expect.stringContaining('auth failed for [secret]') })
  })
})

describe('egressCredentials', () => {
  const environment = parseEnvironment([
    '[[network.credentials]]',
    'host = "api.github.com"',
    'header = "authorization"',
    'value = "Bearer ${GITHUB_TOKEN}"',
    '[[network.credentials]]',
    'host = "api.github.com"',
    'header = "x-extra"',
    'value = "${EXTRA_KEY}"',
    '[[network.credentials]]',
    'host = "registry.npmjs.org"',
    'header = "authorization"',
    'value = "Bearer ${NPM_TOKEN}"',
  ].join('\n'))

  it('fills the proxy keys from the secrets, one entry per host, and names what is missing', () => {
    expect(proxiedSecretNames(environment)).toEqual(['EXTRA_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN'])
    expect(egressCredentials(environment, [{ name: 'GITHUB_TOKEN', value: 'ghp_1' }, { name: 'EXTRA_KEY', value: 'x-1' }])).toEqual({
      credentials: [{ host: 'api.github.com', headers: { authorization: 'Bearer ghp_1', 'x-extra': 'x-1' } }],
      missing: ['NPM_TOKEN'],
    })
  })

  it('refuses a secret that would break out of its header', () => {
    expect(() => egressCredentials(environment, [{ name: 'GITHUB_TOKEN', value: 'ghp_1\r\nx-evil: 1' }, { name: 'EXTRA_KEY', value: 'x' }, { name: 'NPM_TOKEN', value: 'n' }])).toThrow(/line break/)
  })
})

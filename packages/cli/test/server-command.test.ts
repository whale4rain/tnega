import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliError } from '../src/commands.js'
import { assertSafeListen, loadServerSettings, runServerCommand, type ServerIo } from '../src/server-command.js'
import { assertDomain, caddyfile, composeFile, formatEnvFile, parseEnvFile, SERVER_DOCKERFILE } from '../src/server-deploy.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-server-cli-'))
  dirs.push(dir)
  return dir
}

function io(): ServerIo & { written: string } {
  const sink = {
    written: '',
    out(text: string) { sink.written += text },
    err(text: string) { sink.written += text },
    ask: () => Promise.reject(new CliError('no terminal')),
    stdin: () => Promise.resolve(''),
  }
  return sink
}

describe('server settings', () => {
  it('reads the settings file with the environment on top', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'server.env'), formatEnvFile({ DATABASE_URL: 'postgresql://file/db', TNEGA_MASTER_KEY: 'k', TNEGA_SERVER_PORT: '9000' }, 'test'))
    const settings = await loadServerSettings(dir, { DATABASE_URL: 'postgresql://env/db' })
    expect(settings).toMatchObject({ databaseUrl: 'postgresql://env/db', masterKey: 'k', port: 9000, host: '127.0.0.1', membersRoot: join(dir, 'members'), trustProxy: false })
    await expect(loadServerSettings(await tempDir(), {})).rejects.toThrow(/DATABASE_URL/)
  })

  it('serves plain HTTP only on loopback unless a TLS proxy is in front or it was asked for', async () => {
    const dir = await tempDir()
    const base = await loadServerSettings(dir, { DATABASE_URL: 'postgresql://x/y', TNEGA_MASTER_KEY: 'k' })
    expect(() => assertSafeListen(base)).not.toThrow()
    expect(() => assertSafeListen({ ...base, host: '0.0.0.0' })).toThrow(/refusing to serve plain HTTP/)
    expect(() => assertSafeListen({ ...base, host: '0.0.0.0', trustProxy: true })).not.toThrow()
    expect(() => assertSafeListen({ ...base, host: '0.0.0.0', allowHttp: true })).not.toThrow()
  })

  it('round-trips the env file and refuses a value with a line break', () => {
    const text = formatEnvFile({ A: 'one', B: 'a=b' }, 'header\nsecond line')
    expect(text.startsWith('# header\n# second line\n')).toBe(true)
    expect(parseEnvFile(text)).toEqual({ A: 'one', B: 'a=b' })
    expect(() => formatEnvFile({ A: 'x\ny' }, 'h')).toThrow(/line break/)
  })
})

describe('tnega server deploy', () => {
  it('writes a loopback-only setup without a domain, and keeps its secrets on a second run', async () => {
    const dir = await tempDir()
    const first = io()
    expect(await runServerCommand(['deploy', '--dir', dir, '--no-start', '--version', '0.6.0'], first, {})).toBe(0)
    const compose = await readFile(join(dir, 'compose.yaml'), 'utf8')
    expect(compose).toContain('"127.0.0.1:8765:8765"')
    expect(compose).toContain('TNEGA_ALLOW_HTTP: "1"')
    expect(compose).toContain('tnega@0.6.0')
    expect(compose).not.toContain('caddy')
    const env = parseEnvFile(await readFile(join(dir, '.env'), 'utf8'))
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/u)
    expect(Buffer.from(env.TNEGA_MASTER_KEY ?? '', 'base64')).toHaveLength(32)
    if (process.platform !== 'win32') expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
    // Only a packed tnega goes into the image build, never .env.
    expect(await readFile(join(dir, '.dockerignore'), 'utf8')).toBe('*\n!*.tgz\n')
    await runServerCommand(['deploy', '--dir', dir, '--no-start'], io(), {})
    expect(parseEnvFile(await readFile(join(dir, '.env'), 'utf8'))).toMatchObject({ POSTGRES_PASSWORD: env.POSTGRES_PASSWORD, TNEGA_MASTER_KEY: env.TNEGA_MASTER_KEY })
  })

  it('puts Caddy in front for a domain, and uses the mirrors it is given', async () => {
    const dir = await tempDir()
    await runServerCommand(['deploy', '--dir', dir, '--no-start', '--domain', 'tnega.example.com', '--email', 'ops@example.com', '--mirror', 'registry.example.cn/library/', '--npm-registry', 'https://registry.npmmirror.com', '--apt-mirror', 'http://mirrors.aliyun.com'], io(), {})
    const compose = await readFile(join(dir, 'compose.yaml'), 'utf8')
    expect(compose).toContain('TNEGA_TRUST_PROXY: "1"')
    expect(compose).toContain('TNEGA_PUBLIC_URL: https://tnega.example.com')
    expect(compose).toContain('registry.example.cn/library/postgres:17')
    expect(compose).toContain('registry.example.cn/library/caddy:2')
    expect(compose).toContain('https://registry.npmmirror.com')
    expect(compose).toContain('http://mirrors.aliyun.com')
    expect(await readFile(join(dir, 'Caddyfile'), 'utf8')).toBe(caddyfile({ domain: 'tnega.example.com', email: 'ops@example.com', version: 'x', port: 8765 }))
    await expect(runServerCommand(['deploy', '--dir', dir, '--no-start', '--domain', '203.0.113.7'], io(), {})).rejects.toThrow(/not a DNS name/)
  })

  it('builds an image that runs the server as its own user', () => {
    expect(SERVER_DOCKERFILE).toMatch(/USER tnega/u)
    expect(SERVER_DOCKERFILE).toMatch(/CMD \["tnega", "server", "start"\]/u)
    expect(composeFile({ version: '1', port: 9000 })).toContain('"127.0.0.1:9000:8765"')
    expect(() => assertDomain('localhost')).toThrow()
  })

  it('names unknown options and commands', async () => {
    await expect(runServerCommand(['deploy', '--nope'], io(), {})).rejects.toThrow(/unknown option/)
    await expect(runServerCommand(['frobnicate'], io(), {})).rejects.toThrow(/unknown tnega server command/)
  })
})

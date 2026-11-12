import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { isAccountRole, type Account, type AccountRole, type AccountService } from '@tnega/accounts'
import { isLoopbackAddress } from '@tnega/web-kit'
import { CliError } from './commands.js'
import { tnegaVersion } from './help.js'
import {
  assertDomain,
  caddyfile,
  composeFile,
  DOCKERIGNORE,
  formatEnvFile,
  newDatabasePassword,
  newMasterKey,
  parseEnvFile,
  SERVER_DOCKERFILE,
} from './server-deploy.js'

/**
 * `tnega server`: run a tnega server that several people sign in to, and set
 * one up. Settings live in `<dir>/server.env` (owner-only); the process
 * environment wins over the file, which is how Docker passes them.
 */

export const DEFAULT_SERVER_PORT = 8765

export interface ServerSettings {
  dir: string
  databaseUrl: string
  masterKey: string
  host: string
  port: number
  membersRoot: string
  publicUrl: string
  trustProxy: boolean
  allowHttp: boolean
  /** The box settings (`TNEGA_MACHINE`, `TNEGA_BOX_*`, `TNEGA_BOXD_SOCKET`, `E2B_*`), file then environment. */
  boxes: Record<string, string>
}

/** Settings that pick and shape the boxes; see `machinesSpecFromEnv` in `@tnega/runtime`. */
const BOX_SETTING = /^(?:TNEGA_MACHINE|TNEGA_BOX_[A-Z_]+|TNEGA_BOXD_SOCKET|TNEGA_EGRESS_PORT|E2B_API_KEY|E2B_API_URL)$/u

export interface ServerIo {
  out(text: string): void
  err(text: string): void
  /** A line typed by the person, hidden when `secret`. */
  ask(question: string, secret?: boolean): Promise<string>
  /** All of stdin (for `--password-stdin`). */
  stdin(): Promise<string>
}

export function defaultServerDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.TNEGA_SERVER_DIR || join(env.TNEGA_HOME || join(homedir(), '.tnega'), 'server'))
}

type SettingKey = 'DATABASE_URL' | 'TNEGA_MASTER_KEY' | 'TNEGA_SERVER_HOST' | 'TNEGA_SERVER_PORT' | 'TNEGA_MEMBERS_ROOT' | 'TNEGA_PUBLIC_URL' | 'TNEGA_TRUST_PROXY' | 'TNEGA_ALLOW_HTTP'

async function readServerEnv(dir: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(join(dir, 'server.env'), 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
}

async function writeOwnerOnly(file: string, text: string): Promise<void> {
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600)
}

const truthy = (value: string | undefined): boolean => value === '1' || value === 'true' || value === 'yes'

/** Settings from `<dir>/server.env` with the environment on top. */
export async function loadServerSettings(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<ServerSettings> {
  const file = await readServerEnv(dir)
  const value = (key: SettingKey): string | undefined => env[key]?.trim() || file[key]?.trim() || undefined
  const databaseUrl = value('DATABASE_URL')
  if (!databaseUrl) throw new CliError(`no DATABASE_URL: run tnega server init --database-url <url> (settings: ${join(dir, 'server.env')})`)
  const masterKey = value('TNEGA_MASTER_KEY')
  if (!masterKey) throw new CliError('no TNEGA_MASTER_KEY: run tnega server init')
  const host = value('TNEGA_SERVER_HOST') ?? '127.0.0.1'
  const port = Number(value('TNEGA_SERVER_PORT') ?? DEFAULT_SERVER_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError('TNEGA_SERVER_PORT must be a port number')
  return {
    dir,
    databaseUrl,
    masterKey,
    host,
    port,
    membersRoot: resolve(value('TNEGA_MEMBERS_ROOT') ?? join(dir, 'members')),
    publicUrl: value('TNEGA_PUBLIC_URL') ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    trustProxy: truthy(value('TNEGA_TRUST_PROXY')),
    allowHttp: truthy(value('TNEGA_ALLOW_HTTP')),
    boxes: Object.fromEntries([...Object.entries(file), ...Object.entries(env)]
      .flatMap(([key, raw]) => BOX_SETTING.test(key) && raw?.trim() ? [[key, raw.trim()]] : [])),
  }
}

/**
 * A server reached from other machines must sit behind TLS. Listening on a
 * public address is refused unless a TLS proxy is in front (`TNEGA_TRUST_PROXY`)
 * or plain HTTP was asked for by name.
 */
export function assertSafeListen(settings: ServerSettings): void {
  const loopback = settings.host === 'localhost' || isLoopbackAddress(settings.host)
  if (loopback || settings.trustProxy || settings.allowHttp) return
  throw new CliError(`refusing to serve plain HTTP on ${settings.host}: put it behind HTTPS (tnega server deploy --domain), set TNEGA_TRUST_PROXY=1 behind your own TLS proxy, or TNEGA_ALLOW_HTTP=1 to accept the risk`)
}

interface Parsed {
  positional: string[]
  flags: Map<string, string | true>
}

function parse(args: readonly string[], valued: ReadonlySet<string>): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const at = arg.indexOf('=')
    const flag = at > 0 ? arg.slice(0, at) : arg
    if (valued.has(flag)) {
      const next = at > 0 ? arg.slice(at + 1) : args[++index]
      if (next === undefined || next === '') throw new CliError(`${flag} needs a value`)
      flags.set(flag, next)
    } else {
      if (at > 0) throw new CliError(`${flag} takes no value`)
      flags.set(flag, true)
    }
  }
  return { positional, flags }
}

function only(parsed: Parsed, allowed: readonly string[], command: string): void {
  for (const flag of parsed.flags.keys()) if (!allowed.includes(flag)) throw new CliError(`unknown option for tnega server ${command}: ${flag}`)
}

const text = (parsed: Parsed, flag: string): string | undefined => {
  const value = parsed.flags.get(flag)
  return typeof value === 'string' ? value : undefined
}

function role(parsed: Parsed, fallback: AccountRole): AccountRole {
  const value = text(parsed, '--role') ?? fallback
  if (!isAccountRole(value)) throw new CliError('--role must be owner, admin or member')
  return value
}

function inviteLink(settings: ServerSettings, code: string): string {
  return `${settings.publicUrl.replace(/\/+$/u, '')}/?invite=${encodeURIComponent(code)}`
}

async function newPassword(parsed: Parsed, io: ServerIo): Promise<string> {
  if (parsed.flags.has('--password-stdin')) return (await io.stdin()).replace(/\r?\n$/u, '')
  const first = await io.ask('Password: ', true)
  const again = await io.ask('Again: ', true)
  if (first !== again) throw new CliError('the passwords do not match')
  return first
}

function accountRow(account: Account): string {
  return `${account.login.padEnd(20)} ${account.role.padEnd(7)} ${account.disabled ? 'disabled' : 'active  '} ${account.name}`
}

async function withAccounts<T>(settings: ServerSettings, work: (accounts: AccountService) => Promise<T>): Promise<T> {
  const { openAccounts } = await import('@tnega/runtime')
  const { accounts, close } = await openAccounts(settings.databaseUrl)
  try {
    return await work(accounts)
  } finally {
    await close()
  }
}

async function findOrFail(accounts: AccountService, login: string | undefined): Promise<Account> {
  if (!login) throw new CliError('which account? give its login')
  const account = await accounts.findAccount(login)
  if (!account) throw new CliError(`no account ${login}`)
  return account
}

/** `tnega server init`: settings file, tables, and a way in for the first owner. */
async function init(args: readonly string[], io: ServerIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parse(args, new Set(['--dir', '--database-url', '--host', '--port', '--public-url', '--owner', '--name']))
  only(parsed, ['--dir', '--database-url', '--host', '--port', '--public-url', '--owner', '--name', '--password-stdin', '--trust-proxy'], 'init')
  const dir = resolve(text(parsed, '--dir') ?? defaultServerDir(env))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = await readServerEnv(dir)
  const next: Record<string, string> = { ...file }
  const databaseUrl = text(parsed, '--database-url') ?? env.DATABASE_URL ?? file.DATABASE_URL
  if (!databaseUrl) throw new CliError('tnega server init needs --database-url postgresql://user:password@host/db (or DATABASE_URL)')
  if (!env.DATABASE_URL) next.DATABASE_URL = databaseUrl
  // Never replace a master key: every remembered secret is sealed with it.
  if (!file.TNEGA_MASTER_KEY && !env.TNEGA_MASTER_KEY) next.TNEGA_MASTER_KEY = newMasterKey()
  for (const [flag, key] of [['--host', 'TNEGA_SERVER_HOST'], ['--port', 'TNEGA_SERVER_PORT'], ['--public-url', 'TNEGA_PUBLIC_URL']] as const) {
    const value = text(parsed, flag)
    if (value) next[key] = value
  }
  if (parsed.flags.has('--trust-proxy')) next.TNEGA_TRUST_PROXY = '1'
  if (JSON.stringify(next) !== JSON.stringify(file)) {
    await writeOwnerOnly(join(dir, 'server.env'), formatEnvFile(next, 'tnega server settings (tnega server init). Keep this file private:\nTNEGA_MASTER_KEY seals every saved secret; losing it loses them.'))
    io.out(`Settings: ${join(dir, 'server.env')}\n`)
  }
  const settings = await loadServerSettings(dir, env)
  return withAccounts(settings, async accounts => {
    const people = await accounts.listAccounts()
    const owner = text(parsed, '--owner')
    if (owner) {
      const name = text(parsed, '--name')
      const account = await accounts.createAccount({ login: owner, role: 'owner', password: await newPassword(parsed, io), ...(name ? { name } : {}) })
      io.out(`Owner ${account.login} can sign in at ${settings.publicUrl}\n`)
      return 0
    }
    if (people.some(account => account.role === 'owner' && !account.disabled)) {
      io.out(`The server has ${people.length} account(s). Add people with tnega server invite.\n`)
      return 0
    }
    const issued = await accounts.issueCode({ purpose: 'invite', role: 'owner' })
    io.out(`No owner yet. Open this link to create the owner account (valid until ${issued.expiresAt}):\n\n  ${inviteLink(settings, issued.code)}\n\n`)
    return 0
  })
}

/** `tnega server start`: the host in server mode, until interrupted. */
async function start(args: readonly string[], io: ServerIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parse(args, new Set(['--dir', '--host', '--port']))
  only(parsed, ['--dir', '--host', '--port'], 'start')
  const dir = resolve(text(parsed, '--dir') ?? defaultServerDir(env))
  const loaded = await loadServerSettings(dir, env)
  const port = text(parsed, '--port')
  const settings: ServerSettings = { ...loaded, host: text(parsed, '--host') ?? loaded.host, port: port ? Number(port) : loaded.port }
  assertSafeListen(settings)
  const [{ machinesSpecFromEnv, parseMasterKey }, { startWebServer }] = await Promise.all([import('@tnega/runtime'), import('@tnega/host')])
  const masterKey = parseMasterKey(settings.masterKey)
  const machines = await machinesSpecFromEnv(settings.boxes, { dir, databaseUrl: settings.databaseUrl, publicUrl: settings.publicUrl })
  // Agents' commands inherit this process's environment: the keys to the
  // database, to every secret and to the box provider are not theirs.
  for (const key of ['DATABASE_URL', 'TNEGA_MASTER_KEY', 'E2B_API_KEY']) delete env[key]
  await mkdir(settings.membersRoot, { recursive: true })
  const server = await startWebServer({
    host: settings.host,
    port: settings.port,
    state: { sessions: { kind: 'postgres', url: settings.databaseUrl }, masterKey, membersRoot: settings.membersRoot },
    accounts: { url: settings.databaseUrl, membersRoot: settings.membersRoot, trustProxy: settings.trustProxy },
    ...(machines ? { machines } : {}),
  })
  io.out(`tnega server listening on ${server.url}; open ${settings.publicUrl}\n`)
  if (machines) io.out(`Sessions run in ${machines.provider.kind} boxes (template ${machines.pool.template}); boxes dial ${machines.pool.serverUrl}\n`)
  await new Promise<void>(done => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      done()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  io.err('tnega server: stopping\n')
  await server.close()
  return 0
}

async function user(args: readonly string[], io: ServerIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parse(args, new Set(['--dir', '--role', '--name']))
  only(parsed, ['--dir', '--role', '--name', '--password-stdin', '--disable', '--enable'], 'user')
  const [action, login, deviceId] = parsed.positional
  const settings = await loadServerSettings(resolve(text(parsed, '--dir') ?? defaultServerDir(env)), env)
  return withAccounts(settings, async accounts => {
    switch (action) {
      case 'list':
      case undefined: {
        const people = await accounts.listAccounts()
        io.out(people.length ? `${people.map(accountRow).join('\n')}\n` : 'No accounts yet: run tnega server init.\n')
        return 0
      }
      case 'add': {
        if (!login) throw new CliError('tnega server user add <login>')
        const name = text(parsed, '--name')
        const account = await accounts.createAccount({ login, role: role(parsed, 'member'), password: await newPassword(parsed, io), ...(name ? { name } : {}) }, 'cli')
        io.out(`${accountRow(account)}\n`)
        return 0
      }
      case 'set': {
        const account = await findOrFail(accounts, login)
        if (parsed.flags.has('--disable') && parsed.flags.has('--enable')) throw new CliError('--disable or --enable, not both')
        const name = text(parsed, '--name')
        const updated = await accounts.updateAccount(account.id, {
          ...(parsed.flags.has('--role') ? { role: role(parsed, account.role) } : {}),
          ...(name ? { name } : {}),
          ...(parsed.flags.has('--disable') ? { disabled: true } : parsed.flags.has('--enable') ? { disabled: false } : {}),
        }, 'cli')
        io.out(`${accountRow(updated)}\n`)
        return 0
      }
      case 'passwd': {
        const account = await findOrFail(accounts, login)
        await accounts.setPassword(account.id, await newPassword(parsed, io), { actor: 'cli' })
        io.out(`Password changed; ${account.login}'s devices were signed out.\n`)
        return 0
      }
      case 'devices': {
        const account = await findOrFail(accounts, login)
        const devices = (await accounts.listDevices(account.id)).filter(device => !device.revoked)
        io.out(devices.length
          ? `${devices.map(device => `${device.id}  ${device.kind.padEnd(6)} ${device.lastSeen ?? 'never'.padEnd(24)}  ${device.name}`).join('\n')}\n`
          : `${account.login} has no signed-in devices.\n`)
        return 0
      }
      case 'revoke': {
        const account = await findOrFail(accounts, login)
        if (!deviceId) throw new CliError('tnega server user revoke <login> <device id> (see tnega server user devices <login>)')
        if (!await accounts.revokeDevice(account.id, deviceId, 'cli')) throw new CliError(`${account.login} has no device ${deviceId}`)
        io.out(`Revoked ${deviceId}; a daemon on it is disconnected within a minute.\n`)
        return 0
      }
      default:
        throw new CliError('tnega server user list | add <login> | set <login> | passwd <login> | devices <login> | revoke <login> <device id>')
    }
  })
}

async function invite(args: readonly string[], io: ServerIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parse(args, new Set(['--dir', '--role', '--days']))
  only(parsed, ['--dir', '--role', '--days'], 'invite')
  const settings = await loadServerSettings(resolve(text(parsed, '--dir') ?? defaultServerDir(env)), env)
  const days = text(parsed, '--days')
  const ttlMs = days === undefined ? undefined : Number(days) * 24 * 60 * 60_000
  if (ttlMs !== undefined && !(ttlMs > 0)) throw new CliError('--days must be a positive number')
  return withAccounts(settings, async accounts => {
    const issued = await accounts.issueCode({ purpose: 'invite', role: role(parsed, 'member'), ...(ttlMs ? { ttlMs } : {}) })
    io.out(`Invite for a new ${issued.role ?? 'member'} (valid until ${issued.expiresAt}):\n\n  ${inviteLink(settings, issued.code)}\n\nCode: ${issued.code}\n`)
    return 0
  })
}

async function pair(args: readonly string[], io: ServerIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parse(args, new Set(['--dir']))
  only(parsed, ['--dir', '--daemon'], 'pair')
  const settings = await loadServerSettings(resolve(text(parsed, '--dir') ?? defaultServerDir(env)), env)
  return withAccounts(settings, async accounts => {
    const account = await findOrFail(accounts, parsed.positional[0])
    const purpose = parsed.flags.has('--daemon') ? 'daemon' : 'client'
    const issued = await accounts.issueCode({ purpose, accountId: account.id, createdBy: 'cli' })
    io.out(`Pairing code for ${account.login}'s ${purpose} (single use, valid until ${issued.expiresAt}):\n\n  ${issued.code}\n`)
    return 0
  })
}

function run(command: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', code => done(code ?? 1))
  })
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { headers: { 'x-tnega-client': '1' } })
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(done => setTimeout(done, 1_000))
  }
  return false
}

/** `tnega server deploy`: a Compose project with Postgres, the server and (with a domain) HTTPS. */
async function deploy(args: readonly string[], io: ServerIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parse(args, new Set(['--dir', '--domain', '--email', '--version', '--port', '--mirror', '--npm-registry', '--apt-mirror', '--package']))
  only(parsed, ['--dir', '--domain', '--email', '--version', '--port', '--mirror', '--npm-registry', '--apt-mirror', '--package', '--no-start'], 'deploy')
  const dir = resolve(text(parsed, '--dir') ?? join(defaultServerDir(env), 'deploy'))
  const domain = text(parsed, '--domain')?.toLowerCase()
  if (domain) assertDomain(domain)
  const port = Number(text(parsed, '--port') ?? DEFAULT_SERVER_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError('--port must be a port number')
  const email = text(parsed, '--email')
  const mirror = text(parsed, '--mirror')
  const npmRegistry = text(parsed, '--npm-registry')
  const aptMirror = text(parsed, '--apt-mirror')
  const packageFile = text(parsed, '--package')
  const options = {
    version: text(parsed, '--version') ?? tnegaVersion(),
    port,
    ...(domain ? { domain } : {}),
    ...(email ? { email } : {}),
    ...(mirror ? { mirror } : {}),
    ...(npmRegistry ? { npmRegistry } : {}),
    ...(aptMirror ? { aptMirror } : {}),
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, '.dockerignore'), DOCKERIGNORE, 'utf8')
  let installed: string | undefined
  if (packageFile) {
    if (!packageFile.endsWith('.tgz')) throw new CliError('--package takes a .tgz made by npm pack')
    const name = basename(packageFile)
    await copyFile(resolve(packageFile), join(dir, name))
    installed = `/build/${name}`
  }
  // Keep the secrets of an earlier deploy: the database and saved secrets depend on them.
  const previous = await readFile(join(dir, '.env'), 'utf8').then(parseEnvFile, (): Record<string, string> => ({}))
  const secrets = {
    POSTGRES_PASSWORD: previous.POSTGRES_PASSWORD || newDatabasePassword(),
    TNEGA_MASTER_KEY: previous.TNEGA_MASTER_KEY || newMasterKey(),
    ...(installed ? { TNEGA_PACKAGE: installed } : {}),
  }
  await writeOwnerOnly(join(dir, '.env'), formatEnvFile(secrets, 'Secrets for this tnega server (tnega server deploy). Keep private and back up:\nTNEGA_MASTER_KEY seals every saved secret.'))
  await writeFile(join(dir, 'compose.yaml'), composeFile(options), 'utf8')
  await writeFile(join(dir, 'server.Dockerfile'), SERVER_DOCKERFILE, 'utf8')
  if (domain) await writeFile(join(dir, 'Caddyfile'), caddyfile(options), 'utf8')
  io.out(`Wrote ${dir}: compose.yaml, server.Dockerfile, .env${domain ? ', Caddyfile' : ''}${installed ? `, ${basename(installed)}` : ''}\n`)
  if (parsed.flags.has('--no-start')) {
    io.out(`Start it with: cd ${dir} && docker compose up -d --build\n`)
    return 0
  }
  const up = await run('docker', ['compose', 'up', '-d', '--build'], dir).catch((error: unknown) => {
    throw new CliError(`could not run docker compose (${error instanceof Error ? error.message : String(error)}); install Docker with the compose plugin, or use --no-start`)
  })
  if (up !== 0) return up
  if (!await waitForHealth(`http://127.0.0.1:${port}/api/health`, 120_000)) {
    io.err(`The server did not answer within two minutes; see: cd ${dir} && docker compose logs server\n`)
    return 1
  }
  // The first owner's invite, printed by the server container itself.
  return run('docker', ['compose', 'exec', '-T', 'server', 'tnega', 'server', 'init'], dir)
}

const USAGE = `tnega server <command>

  init      write settings, create tables, print the first owner's invite
  start     run the server (sign-in required)
  deploy    write and start a Docker Compose setup (Postgres, server, HTTPS)
  user      list | add <login> | set <login> | passwd <login> | devices <login> | revoke <login> <id>
  invite    print an invite link for a new person (--role member|admin|owner)
  pair      print a pairing code for <login>'s client or --daemon
`

export async function runServerCommand(args: readonly string[], io: ServerIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = args
  switch (command) {
    case 'init': return init(rest, io, env)
    case 'start': return start(rest, io, env)
    case 'deploy': return deploy(rest, io, env)
    case 'user': return user(rest, io, env)
    case 'invite': return invite(rest, io, env)
    case 'pair': return pair(rest, io, env)
    case undefined:
    case 'help':
      io.out(USAGE)
      return command === undefined ? 2 : 0
    default:
      throw new CliError(`unknown tnega server command: ${command}\n\n${USAGE}`)
  }
}

/** Terminal input and output, with the password prompt not echoed. */
export function terminalIo(): ServerIo {
  return {
    out: text => { process.stdout.write(text) },
    err: text => { process.stderr.write(text) },
    stdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return Buffer.concat(chunks).toString('utf8')
    },
    ask: (question, secret = false) => new Promise((done, fail) => {
      const input = process.stdin
      if (!input.isTTY) {
        fail(new CliError('no terminal to ask in: use --password-stdin'))
        return
      }
      process.stdout.write(question)
      let typed = ''
      input.setRawMode(true)
      input.resume()
      input.setEncoding('utf8')
      const finish = (error?: Error): void => {
        input.setRawMode(false)
        input.pause()
        input.off('data', onData)
        process.stdout.write('\n')
        if (error) fail(error)
        else done(typed)
      }
      const onData = (data: string): void => {
        for (const char of data) {
          if (char === '\r' || char === '\n') return finish()
          if (char === '\u0003') return finish(new CliError('cancelled'))
          if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
          else typed += char
          if (!secret) process.stdout.write(char)
        }
      }
      input.on('data', onData)
    }),
  }
}

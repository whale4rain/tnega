import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'
import type { ExecutionProvider, ShellResult } from '@tnega/process'
import { parse as parseToml, TomlError } from 'smol-toml'

/**
 * `.tnega/environment.toml`: what a project's box is made of. The file is
 * repository content, so whoever can change the repository can change it; the
 * parts that touch secrets or the network are covered by {@link approvalHash},
 * and the person approves the environment again whenever that hash changes.
 */

export const ENVIRONMENT_FILE = '.tnega/environment.toml'

/** Package registries the setup step may always reach. */
export const DEFAULT_SETUP_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'index.crates.io',
  'static.crates.io',
  'rubygems.org',
  'repo.maven.apache.org',
  'deb.debian.org',
  'security.debian.org',
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
]

export interface Environment {
  /** Box template to start from; absent means tnega's default box template. */
  template?: string
  resources: { cpus?: number; memoryMb?: number; pids?: number }
  setup?: EnvironmentSetup
  network: EnvironmentNetwork
  idle: { pauseAfterMinutes: number }
}

export interface EnvironmentSetup {
  /** Shell script run once in the workspace, before the agent's first turn. */
  script: string
  /** Secret names the script may read, as environment variables. */
  secrets: string[]
  /** Hosts the setup step may reach beyond {@link DEFAULT_SETUP_HOSTS}. */
  hosts: string[]
}

export interface EnvironmentNetwork {
  /** No proxy and no host list: the box reaches anything. An explicit opt-out. */
  open: boolean
  /** Hosts the agent's commands may reach (`example.com`, `*.example.com`). */
  allow: string[]
  /** Keys the egress proxy adds; the box never sees them. */
  credentials: EnvironmentCredential[]
}

export interface EnvironmentCredential {
  /** Exact host name; the key is added to HTTPS requests for this host only. */
  host: string
  header: string
  /** The header value, with `${NAME}` naming a secret, e.g. `Bearer ${GITHUB_TOKEN}`. */
  value: string
}

export class EnvironmentError extends Error {
  override name = 'EnvironmentError'

  constructor(message: string, readonly code: 'ENVIRONMENT_INVALID' | 'SETUP_FAILED') {
    super(message)
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const SECRET_REF = /\$\{([^}]*)\}/gu

type Table = Record<string, unknown>

function isTable(value: unknown): value is Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

/** Read and check an environment file. Unknown keys are refused so a typo never weakens a rule. */
export function parseEnvironment(text: string): Environment {
  let raw: Table
  try {
    raw = parseToml(text)
  } catch (error) {
    const where = error instanceof TomlError ? ` (line ${error.line}, column ${error.column})` : ''
    throw new EnvironmentError(`${ENVIRONMENT_FILE} is not valid TOML${where}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, 'ENVIRONMENT_INVALID')
  }
  const fail = (message: string): never => { throw new EnvironmentError(`${ENVIRONMENT_FILE}: ${message}`, 'ENVIRONMENT_INVALID') }
  const only = (table: Table, where: string, keys: readonly string[]): void => {
    for (const key of Object.keys(table)) if (!keys.includes(key)) fail(`unknown key ${where}${key}`)
  }
  const table = (value: unknown, where: string): Table => {
    if (value === undefined) return {}
    if (!isTable(value)) fail(`[${where}] must be a table`)
    return value as Table
  }
  const strings = (value: unknown, where: string): string[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) fail(`${where} must be a list of strings`)
    return value as string[]
  }
  const positive = (value: unknown, where: string, min: number): number | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) fail(`${where} must be a whole number of at least ${min}`)
    return value as number
  }
  const hosts = (list: string[], where: string): string[] => list.map(host => {
    const lower = host.trim().toLowerCase()
    if (!HOST.test(lower)) fail(`${where} has ${JSON.stringify(host)}, which is not a host name (use example.com or *.example.com)`)
    return lower
  })

  only(raw, '', ['version', 'template', 'resources', 'setup', 'network', 'idle'])
  if (raw.version !== undefined && raw.version !== 1) fail('version must be 1')
  if (raw.template !== undefined && (typeof raw.template !== 'string' || !raw.template.trim())) fail('template must be a template name')

  const resources = table(raw.resources, 'resources')
  only(resources, 'resources.', ['cpus', 'memory_mb', 'pids'])
  const cpus = positive(resources.cpus, 'resources.cpus', 1)
  const memoryMb = positive(resources.memory_mb, 'resources.memory_mb', 128)
  const pids = positive(resources.pids, 'resources.pids', 16)

  let setup: EnvironmentSetup | undefined
  if (raw.setup !== undefined) {
    const section = table(raw.setup, 'setup')
    only(section, 'setup.', ['script', 'secrets', 'hosts'])
    if (typeof section.script !== 'string' || !section.script.trim()) fail('setup.script must be a non-empty string')
    const secrets = strings(section.secrets, 'setup.secrets')
    for (const secret of secrets) if (!NAME.test(secret)) fail(`setup.secrets has ${JSON.stringify(secret)}, which is not a variable name`)
    setup = { script: section.script as string, secrets: [...new Set(secrets)].sort(), hosts: hosts(strings(section.hosts, 'setup.hosts'), 'setup.hosts') }
  }

  const network = table(raw.network, 'network')
  only(network, 'network.', ['open', 'allow', 'credentials'])
  if (network.open !== undefined && typeof network.open !== 'boolean') fail('network.open must be true or false')
  const credentials: EnvironmentCredential[] = []
  if (network.credentials !== undefined) {
    if (!Array.isArray(network.credentials)) fail('[[network.credentials]] must be a list of tables')
    for (const [index, entry] of (network.credentials as unknown[]).entries()) {
      const where = `network.credentials[${index}]`
      if (!isTable(entry)) fail(`${where} must be a table`)
      const item = entry as Table
      only(item, `${where}.`, ['host', 'header', 'value'])
      if (typeof item.host !== 'string' || item.host.startsWith('*.') || !HOST.test(item.host.toLowerCase())) fail(`${where}.host must be one exact host name`)
      if (typeof item.header !== 'string' || !/^[A-Za-z0-9-]+$/u.test(item.header)) fail(`${where}.header must be a header name`)
      if (typeof item.value !== 'string') fail(`${where}.value must be a string`)
      const names = [...(item.value as string).matchAll(SECRET_REF)].map(match => match[1] ?? '')
      if (!names.length) fail(`${where}.value must name a secret, like "Bearer \${GITHUB_TOKEN}"`)
      for (const name of names) if (!NAME.test(name)) fail(`${where}.value names ${JSON.stringify(name)}, which is not a secret name`)
      credentials.push({ host: (item.host as string).toLowerCase(), header: (item.header as string).toLowerCase(), value: item.value as string })
    }
  }
  const open = network.open === true
  const allow = hosts(strings(network.allow, 'network.allow'), 'network.allow')
  if (open && (allow.length || credentials.length)) fail('network.open = true cannot be combined with allow or credentials: an open box has no proxy to add keys')

  const idle = table(raw.idle, 'idle')
  only(idle, 'idle.', ['pause_after_minutes'])
  const pauseAfterMinutes = positive(idle.pause_after_minutes, 'idle.pause_after_minutes', 1) ?? 5

  return {
    ...(typeof raw.template === 'string' ? { template: raw.template.trim() } : {}),
    resources: { ...(cpus !== undefined ? { cpus } : {}), ...(memoryMb !== undefined ? { memoryMb } : {}), ...(pids !== undefined ? { pids } : {}) },
    ...(setup ? { setup } : {}),
    network: { open, allow, credentials },
    idle: { pauseAfterMinutes },
  }
}

/** Every secret the environment uses: the setup's and the ones the proxy adds. */
export function secretNames(environment: Environment): string[] {
  const names = new Set(environment.setup?.secrets ?? [])
  for (const credential of environment.network.credentials) {
    for (const match of credential.value.matchAll(SECRET_REF)) names.add(match[1] ?? '')
  }
  return [...names].sort()
}

/** The secrets the egress proxy adds to requests: a box's commands get only placeholders for these. */
export function proxiedSecretNames(environment: Environment): string[] {
  const names = new Set<string>()
  for (const credential of environment.network.credentials) {
    for (const match of credential.value.matchAll(SECRET_REF)) names.add(match[1] ?? '')
  }
  return [...names].sort()
}

/** One host's key for the egress proxy (`@tnega/egress-proxy`'s `EgressCredential`). */
export interface ResolvedCredential {
  host: string
  headers: Record<string, string>
}

/**
 * The egress proxy's keys for an environment, with each `${NAME}` filled from
 * the user's secrets. A credential naming a secret the user has not given is
 * left out and reported in `missing`, never sent with the reference in it.
 * Credentials for one host are merged into one entry.
 */
export function egressCredentials(
  environment: Environment,
  secrets: ReadonlyArray<{ name: string; value: string }>,
): { credentials: ResolvedCredential[]; missing: string[] } {
  const values: Record<string, string> = Object.create(null)
  for (const secret of secrets) values[secret.name] = secret.value
  const byHost = new Map<string, Record<string, string>>()
  const missing = new Set<string>()
  for (const credential of environment.network.credentials) {
    const names = [...credential.value.matchAll(SECRET_REF)].map(match => match[1] ?? '')
    const absent = names.filter(name => values[name] === undefined)
    if (absent.length) {
      for (const name of absent) missing.add(name)
      continue
    }
    const value = resolveCredential(credential, values)
    // A value with a line break would let a secret add headers of its own.
    if (/[\r\n]/u.test(value)) throw new EnvironmentError(`a secret for ${credential.host} holds a line break and cannot go in a header`, 'ENVIRONMENT_INVALID')
    const headers = byHost.get(credential.host) ?? {}
    headers[credential.header] = value
    byHost.set(credential.host, headers)
  }
  return {
    credentials: [...byHost].map(([host, headers]) => ({ host, headers })),
    missing: [...missing].sort(),
  }
}

/**
 * What the person approves: the template, the setup script, the hosts it may reach, every
 * secret name and where each key is sent, and whether the box is open. A
 * change to any of these asks again; resources and idle time do not.
 */
export function approvalHash(environment: Environment): string {
  const covered = {
    // The image setup secrets run in.
    template: environment.template ?? null,
    setup: environment.setup ? { script: environment.setup.script, secrets: environment.setup.secrets, hosts: [...environment.setup.hosts].sort() } : null,
    secrets: secretNames(environment),
    open: environment.network.open,
    allow: [...environment.network.allow].sort(),
    credentials: environment.network.credentials.map(({ host, header, value }) => ({ host, header, value }))
      .sort((a, b) => `${a.host}\n${a.header}`.localeCompare(`${b.host}\n${b.header}`)),
  }
  return createHash('sha256').update(JSON.stringify(covered)).digest('hex')
}

/** Put secret values into a credential's header value; a missing secret is an error, never an empty key. */
export function resolveCredential(credential: EnvironmentCredential, secrets: Readonly<Record<string, string>>): string {
  return credential.value.replace(SECRET_REF, (_, name: string) => {
    const value = secrets[name]
    if (value === undefined) throw new EnvironmentError(`secret ${name} for ${credential.host} is not set`, 'ENVIRONMENT_INVALID')
    return value
  })
}

export interface SetupRun {
  /** The workspace inside the box. */
  cwd: string
  script: string
  /** The approved secrets, by name. They reach this one command's environment only. */
  secrets: Readonly<Record<string, string>>
  /** The egress proxy URL with the setup-phase client in it; absent for an open box. */
  proxyUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void
}

const SETUP_TIMEOUT_MS = 30 * 60_000
/** Shorter secrets are refused: redacting them would hide ordinary text as well. */
export const MIN_SECRET_LENGTH = 8

/**
 * Run the setup step through a box's `ctx.process` (a daemon's remote
 * ExecutionProvider). Secrets travel in this one command's environment, so
 * they are never written into the box's environment, its template or a file.
 * Fails with `SETUP_FAILED` on a non-zero exit, with the tail of the output.
 * Secret values are hidden in the streamed output, the result and the error.
 */
export async function runSetup(execution: Pick<ExecutionProvider, 'runShell'>, run: SetupRun): Promise<ShellResult> {
  for (const [name, value] of Object.entries(run.secrets)) {
    // A value this short cannot be hidden in output without hiding ordinary text too.
    if (value.length < MIN_SECRET_LENGTH) throw new EnvironmentError(`secret ${name} is shorter than ${MIN_SECRET_LENGTH} characters and could not be kept out of the setup output`, 'ENVIRONMENT_INVALID')
    // Starting a process with a NUL in its environment fails with an error that quotes the value.
    if (value.includes('\0')) throw new EnvironmentError(`secret ${name} contains a NUL character`, 'ENVIRONMENT_INVALID')
  }
  const env: Record<string, string> = { ...run.secrets }
  if (run.proxyUrl) {
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) env[name] = run.proxyUrl
  }
  const stream = run.onOutput ? redactingStream(run.secrets, run.onOutput) : undefined
  let result: ShellResult
  try {
    result = await execution.runShell({
      command: run.script,
      cwd: run.cwd,
      env,
      timeoutMs: run.timeoutMs ?? SETUP_TIMEOUT_MS,
      ...(run.signal ? { signal: run.signal } : {}),
      ...(stream ? { onOutput: stream.write } : {}),
    })
  } catch (error) {
    // The command could not run; its error may quote the environment.
    const message = error instanceof Error ? error.message : String(error)
    throw new EnvironmentError(`setup could not run: ${redact(message, run.secrets)}`, 'SETUP_FAILED')
  }
  stream?.flush()
  if (result.exitCode !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-20).join('\n')
    throw new EnvironmentError(`setup exited with ${result.exitCode}:\n${redact(tail, run.secrets)}`, 'SETUP_FAILED')
  }
  return { ...result, stdout: redact(result.stdout, run.secrets), stderr: redact(result.stderr, run.secrets) }
}

type OutputSink = (chunk: Buffer, stream: 'stdout' | 'stderr') => void

/**
 * Redact streamed output. Each stream holds back as many characters as the
 * longest secret minus one, so a secret split across two chunks is still
 * caught; `flush` sends what is held back once the command ends.
 */
function redactingStream(secrets: Readonly<Record<string, string>>, sink: OutputSink): { write: OutputSink; flush: () => void } {
  const hold = Math.max(0, ...Object.values(secrets).filter(value => value.length >= 4).map(value => value.length - 1))
  const state = { stdout: { decoder: new StringDecoder('utf8'), pending: '' }, stderr: { decoder: new StringDecoder('utf8'), pending: '' } }
  const write: OutputSink = (chunk, name) => {
    const entry = state[name]
    const text = redact(entry.pending + entry.decoder.write(chunk), secrets)
    const cut = Math.max(0, text.length - hold)
    entry.pending = text.slice(cut)
    if (cut > 0) sink(Buffer.from(text.slice(0, cut), 'utf8'), name)
  }
  const flush = (): void => {
    for (const name of ['stdout', 'stderr'] as const) {
      const entry = state[name]
      const text = redact(entry.pending + entry.decoder.end(), secrets)
      entry.pending = ''
      if (text) sink(Buffer.from(text, 'utf8'), name)
    }
  }
  return { write, flush }
}

/** Hide secret values that a script echoed, before the text reaches a person or a log. */
export function redact(text: string, secrets: Readonly<Record<string, string>>): string {
  let out = text
  for (const value of Object.values(secrets)) if (value.length >= 4) out = out.split(value).join('[secret]')
  return out
}

export const name = '@tnega/environment'

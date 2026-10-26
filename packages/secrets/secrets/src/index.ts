import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    secrets: SecretStore
  }
}

/** A secret as anyone but its consumers may see it: the name, never the value. */
export interface SecretInfo {
  name: string
  /** Saved for the workspace, so it survives a restart; otherwise it lives in memory. */
  remembered: boolean
}

/** A name with its value. Only the env and masking consumers read these. */
export interface SecretEntry {
  name: string
  value: string
}

export interface SetSecretOptions {
  /** Save it for the workspace instead of keeping it for this session only. */
  remember?: boolean
}

export type SecretErrorCode =
  /** The name cannot be an environment variable, or would replace one the host relies on. */
  | 'SECRET_INVALID'
  /** The store could not keep or remove the value. */
  | 'SECRET_FAILED'
  /** No store is mounted in this scope. */
  | 'SECRETS_UNAVAILABLE'

export class SecretError extends Error {
  override name = 'SecretError'
  constructor(message: string, readonly code: SecretErrorCode, options?: ErrorOptions) {
    super(message, options)
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Variables a command needs to start, find programs or load code. A secret
 * with one of these names would break every command, or let a value choose
 * what runs, so they are refused.
 */
const RESERVED = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'IFS', 'PS4',
  'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'TZ',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT',
  'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'JDK_JAVA_OPTIONS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
])

/**
 * Families where any one variable chooses code a command loads or runs
 * (`LD_AUDIT`, `NPM_CONFIG_SCRIPT_SHELL`, `JAVA_TOOL_OPTIONS`,
 * `GIT_CONFIG_COUNT`) or where it fetches from. A secret there would act as
 * configuration rather than data, so the whole family is refused.
 */
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'NPM_CONFIG_', 'JAVA_', '_JAVA_', 'GIT_CONFIG_']

/** Why `name` cannot name a secret, or `undefined` when it can. */
export function secretNameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || !NAME.test(name)) {
    return 'A secret name must be an environment variable name: letters, digits and _, not starting with a digit, at most 64 characters'
  }
  const upper = name.toUpperCase()
  if (RESERVED.has(upper)) return `${name} is a variable commands rely on and cannot hold a secret`
  if (upper.startsWith('TNEGA_')) return 'Names starting with TNEGA_ are reserved for tnega itself'
  if (RESERVED_PREFIXES.some(prefix => upper.startsWith(prefix))) {
    return `${name} is a variable commands rely on and cannot hold a secret`
  }
  return undefined
}

export function assertSecretName(name: unknown): asserts name is string {
  const problem = secretNameProblem(name)
  if (problem) throw new SecretError(problem, 'SECRET_INVALID')
}

/**
 * The secrets of one Agent scope (one Session).
 *
 * Contract:
 *
 * - **Values go to commands only.** Consumers put them into a child process's
 *   environment and mask them out of text. Nothing writes a value into a
 *   Session, an event payload or a tool result.
 * - **Names are public.** `list()` is what the model, the UI and the Session see.
 * - **The scope is bound at mount time.** A store answers for exactly one
 *   Session; the composition layer mounts one per Agent scope.
 *
 * This package only holds the contract and its vocabulary; a Provider
 * subclasses {@link SecretStore} and mounts it as a plugin.
 */
export abstract class SecretStore extends Service {
  /**
   * Values this scope has handed to a command, kept so masking still catches
   * them afterwards. A user can remove a secret while a command that already
   * reads it runs, or between the call that got it and the result coming back;
   * the store then no longer holds the value, but it is still a value the model
   * must not see. Per scope, not per call: a value a command was given stays
   * masked in everything this scope reports later, even once removed.
   */
  private readonly injected = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'secrets')
  }

  /** Keep `value` under `name`, replacing an earlier value of that name. */
  abstract set(name: string, value: string, options?: SetSecretOptions): Promise<SecretInfo>
  /** Forget `name` for this scope, remembered or not. Resolves whether anything was removed. */
  abstract remove(name: string): Promise<boolean>
  /** Names in this scope, sorted. */
  abstract list(): Promise<SecretInfo[]>
  /** Names with values, for the environment and masking consumers only. */
  abstract entries(): Promise<SecretEntry[]>

  /** Remember that `entries` went into a child process's environment. */
  noteInjected(entries: readonly SecretEntry[]): void {
    for (const { name, value } of entries) this.injected.set(name, value)
  }

  /**
   * Values to mask with: the current ones, plus every value a command was
   * given in this scope, including one removed since.
   */
  async maskingEntries(): Promise<SecretEntry[]> {
    const merged = new Map(this.injected)
    for (const entry of await this.entries()) merged.set(entry.name, entry.value)
    return [...merged]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Environment variables for a child process. */
export function secretEnv(entries: readonly SecretEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map(entry => [entry.name, entry.value]))
}

/** Shorter values are left alone: masking `abc` everywhere would wreck ordinary output. */
const MIN_MASK_LENGTH = 4
/** Encoded forms of short values match too much unrelated text. */
const MIN_ENCODED_LENGTH = 8

interface Pattern { text: string; name: string }

function patterns(entries: readonly SecretEntry[]): Pattern[] {
  const seen = new Set<string>()
  const found: Pattern[] = []
  const add = (text: string, name: string) => {
    if (text.length < MIN_MASK_LENGTH || seen.has(text)) return
    seen.add(text)
    found.push({ text, name })
  }
  for (const { name, value } of entries) {
    add(value, name)
    if (value.length < MIN_ENCODED_LENGTH) continue
    const base64 = Buffer.from(value, 'utf8').toString('base64')
    add(base64, name)
    add(base64.replace(/=+$/, ''), name)
    add(Buffer.from(value, 'utf8').toString('base64url'), name)
    add(encodeURIComponent(value), name)
  }
  // Longest first, so a value that contains another is masked whole.
  return found.sort((a, b) => b.text.length - a.text.length)
}

export function secretPlaceholder(name: string): string {
  return `[secret: ${name}]`
}

function maskWith(text: string, list: readonly Pattern[]): string {
  let masked = text
  for (const pattern of list) {
    if (masked.includes(pattern.text)) masked = masked.replaceAll(pattern.text, secretPlaceholder(pattern.name))
  }
  return masked
}

/**
 * Replace every secret value in `text`, plain or in a common encoding
 * (base64, base64url, URL-encoded), with `[secret: NAME]`.
 */
export function maskSecrets(text: string, entries: readonly SecretEntry[]): string {
  if (!text || entries.length === 0) return text
  return maskWith(text, patterns(entries))
}

/** {@link maskSecrets} over every string inside a JSON-like value. */
export function maskSecretsDeep(value: unknown, entries: readonly SecretEntry[]): unknown {
  if (entries.length === 0) return value
  const list = patterns(entries)
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return maskWith(item, list)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]))
    }
    return item
  }
  return visit(value)
}

export interface StreamMasker {
  /** Masked text that is safe to show now. A tail that may be the start of a value waits for the next chunk. */
  push(chunk: string): string
  /** Whatever is still held back, masked. */
  flush(): string
}

/**
 * Mask a stream of text pieces. A value split across two pieces is still
 * masked: the end of a piece that could begin a value is held back until the
 * next piece shows whether it does.
 */
export function createStreamMasker(entries: readonly SecretEntry[]): StreamMasker {
  const list = patterns(entries)
  let pending = ''
  const heldBack = (text: string): number => {
    let longest = 0
    for (const { text: value } of list) {
      for (let size = Math.min(value.length - 1, text.length); size > longest; size--) {
        if (text.endsWith(value.slice(0, size))) { longest = size; break }
      }
    }
    return longest
  }
  return {
    push(chunk) {
      if (list.length === 0) return chunk
      const masked = maskWith(pending + chunk, list)
      const hold = heldBack(masked)
      pending = hold ? masked.slice(-hold) : ''
      return hold ? masked.slice(0, -hold) : masked
    },
    flush() {
      const rest = maskWith(pending, list)
      pending = ''
      return rest
    },
  }
}

export default SecretStore

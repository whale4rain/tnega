import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@tnega/core'
import { resolveTnegaHome, workspaceStorageKey } from '@tnega/home'
import {
  assertSecretName,
  SecretError,
  SecretStore,
  type SecretEntry,
  type SecretInfo,
  type SetSecretOptions,
} from '@tnega/secrets'

export { secretRoutes } from './routes.js'

/** One Session in one workspace. */
export interface SecretScope {
  workspace: string
  sessionId: string
}

export interface SecretVaultOptions {
  /** Where remembered secrets live; defaults to `<tnega home>/secrets.json`. */
  file?: string
}

interface SavedWorkspace { path: string; secrets: Record<string, string> }
interface SavedFile { version: 1; workspaces: Record<string, SavedWorkspace> }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSaved(text: string): SavedFile {
  const parsed: unknown = JSON.parse(text)
  const workspaces: Record<string, SavedWorkspace> = {}
  if (record(parsed) && record(parsed.workspaces)) {
    for (const [key, entry] of Object.entries(parsed.workspaces)) {
      if (!record(entry) || typeof entry.path !== 'string' || !record(entry.secrets)) continue
      // Null prototype: a secret may legitimately be named `__proto__`.
      const secrets: Record<string, string> = Object.create(null)
      for (const [name, value] of Object.entries(entry.secrets)) if (typeof value === 'string') secrets[name] = value
      workspaces[key] = { path: entry.path, secrets }
    }
  }
  return { version: 1, workspaces }
}

/**
 * The host's secrets: session ones in memory, remembered ones in one file
 * only the user can read.
 *
 * A host keeps one vault for its whole life and mounts {@link secretsLocal}
 * into each Agent scope with that scope's workspace and Session, because Agent
 * runtimes are rebuilt (a model or permission change, an idle resident) while
 * the user expects a key they typed to stay.
 */
export class SecretVault {
  readonly file: string
  private readonly session = new Map<string, Map<string, string>>()
  private writing: Promise<void> = Promise.resolve()

  constructor(options: SecretVaultOptions = {}) {
    this.file = options.file ?? join(resolveTnegaHome(), 'secrets.json')
  }

  private sessionKey(scope: SecretScope): string {
    return `${workspaceStorageKey(scope.workspace)}\0${scope.sessionId}`
  }

  private async readSaved(): Promise<SavedFile> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, workspaces: {} }
      throw new SecretError('Saved secrets could not be read', 'SECRET_FAILED', { cause: error })
    }
    try {
      return parseSaved(text)
    } catch (error) {
      throw new SecretError(`Saved secrets are damaged; fix or delete ${this.file}`, 'SECRET_FAILED', { cause: error })
    }
  }

  private async remembered(workspace: string): Promise<Record<string, string>> {
    return (await this.readSaved()).workspaces[workspaceStorageKey(workspace)]?.secrets ?? {}
  }

  /** Change the saved file, one change at a time, replacing it whole. */
  private async updateSaved(change: (file: SavedFile) => boolean): Promise<boolean> {
    let changed = false
    const run = this.writing.then(async () => {
      const saved = await this.readSaved()
      changed = change(saved)
      if (!changed) return
      for (const [key, entry] of Object.entries(saved.workspaces)) {
        if (Object.keys(entry.secrets).length === 0) delete saved.workspaces[key]
      }
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        // writeFile's mode is masked by the umask; make sure it is owner-only.
        await chmod(temporary, 0o600)
        await rename(temporary, this.file)
      } catch (error) {
        await rm(temporary, { force: true })
        throw new SecretError('Secret could not be saved', 'SECRET_FAILED', { cause: error })
      }
    })
    this.writing = run.catch(() => {})
    await run
    return changed
  }

  async set(scope: SecretScope, name: string, value: string, options: SetSecretOptions = {}): Promise<SecretInfo> {
    assertSecretName(name)
    if (!value) throw new SecretError('A secret needs a value', 'SECRET_INVALID')
    const key = this.sessionKey(scope)
    if (options.remember) {
      const workspaceKey = workspaceStorageKey(scope.workspace)
      await this.updateSaved(saved => {
        const entry = saved.workspaces[workspaceKey] ??= {
          path: resolve(scope.workspace),
          secrets: Object.create(null) as Record<string, string>,
        }
        entry.secrets[name] = value
        return true
      })
      // The saved value is now the one; a session value would hide it.
      this.session.get(key)?.delete(name)
      return { name, remembered: true }
    }
    let values = this.session.get(key)
    if (!values) this.session.set(key, values = new Map())
    values.set(name, value)
    return { name, remembered: false }
  }

  async remove(scope: SecretScope, name: string): Promise<boolean> {
    const values = this.session.get(this.sessionKey(scope))
    const fromSession = values?.delete(name) ?? false
    const workspaceKey = workspaceStorageKey(scope.workspace)
    const fromFile = await this.updateSaved(saved => {
      const entry = saved.workspaces[workspaceKey]
      // Own keys only: `toString` and `constructor` are not stored secrets.
      if (!entry || !Object.hasOwn(entry.secrets, name)) return false
      delete entry.secrets[name]
      return true
    })
    return fromSession || fromFile
  }

  /** Values for this scope: remembered ones, with this session's own on top. */
  async entries(scope: SecretScope): Promise<SecretEntry[]> {
    const merged = new Map(Object.entries(await this.remembered(scope.workspace)))
    for (const [name, value] of this.session.get(this.sessionKey(scope)) ?? []) merged.set(name, value)
    return [...merged].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name))
  }

  async list(scope: SecretScope): Promise<SecretInfo[]> {
    const saved = await this.remembered(scope.workspace)
    const session = this.session.get(this.sessionKey(scope))
    const names = new Set([...Object.keys(saved), ...(session?.keys() ?? [])])
    return [...names].sort().map(name => ({ name, remembered: !session?.has(name) }))
  }

  /** Forget a Session's in-memory secrets, e.g. when the Session is deleted. */
  forgetSession(scope: SecretScope): void {
    this.session.delete(this.sessionKey(scope))
  }
}

export interface SecretsLocalConfig extends SecretScope {
  vault: SecretVault
}

/** The vault, seen from one Agent scope. */
export class LocalSecretStore extends SecretStore {
  constructor(ctx: Context, private readonly config: SecretsLocalConfig) {
    super(ctx)
  }

  private get scope(): SecretScope {
    return { workspace: this.config.workspace, sessionId: this.config.sessionId }
  }

  override set(name: string, value: string, options?: SetSecretOptions): Promise<SecretInfo> {
    return this.config.vault.set(this.scope, name, value, options)
  }

  override remove(name: string): Promise<boolean> {
    return this.config.vault.remove(this.scope, name)
  }

  override list(): Promise<SecretInfo[]> {
    return this.config.vault.list(this.scope)
  }

  override entries(): Promise<SecretEntry[]> {
    return this.config.vault.entries(this.scope)
  }
}

/** Provider of `ctx.secrets`, backed by a host-owned {@link SecretVault}. */
export const secretsLocal = {
  name: 'secrets-local',
  apply(ctx: Context, config: SecretsLocalConfig): void {
    new LocalSecretStore(ctx, config)
  },
}

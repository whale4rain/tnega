import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { Context } from '@tnega/core'
import { resolveTnegaHome, workspaceStorageKey } from '@tnega/home'
import { foldSessionMeta, type SessionEvent } from '@tnega/session'
import {
  SessionSearchError,
  SessionSearchService,
  sessionEventText,
  type SessionEventMatch,
  type SessionEventSearchRequest,
  type SessionEventSearchResult,
  type SessionMatch,
  type SessionReadEntry,
  type SessionReadRequest,
  type SessionReadResult,
  type SessionRef,
  type SessionSearchRequest,
  type SessionSearchResult,
  type SessionTextKind,
} from '@tnega/session-search'
import { isSessionId, readSessionEventsReadOnly, sessionDir } from '@tnega/session-store'

export interface SqliteSessionIndexOptions {
  /** Defaults to `session-index.sqlite` in the tnega home. */
  path?: string
  /**
   * How much text the index keeps, in characters. Past it, the sessions used
   * least are dropped until the index is back to 80% of this.
   */
  maxChars?: number
  /** A session used this recently is never dropped. */
  keepUsedWithinMs?: number
  now?: () => number
}

export const DEFAULT_MAX_INDEXED_CHARS = 20_000_000
const DEFAULT_KEEP_USED_MS = 60 * 60 * 1000
const SCHEMA_VERSION = 1
/** How much of one message the index keeps. */
const INDEXED_EVENT_CHARS = 4_000
/** How much of one message a read returns. */
const READ_EVENT_CHARS = 4_000
/** Rows a cross-session search ranks before grouping them by session. */
const MAX_RANKED_ROWS = 2_000

/** How much one kind of use adds to a session's usage count. */
const USE = { listed: 1, searched: 2, read: 2 } as const

interface SessionRow {
  key: string
  workspace: string
  workspace_key: string
  session_id: string
  title: string
  updated_at: number
  file_size: number
  file_mtime: number
  last_seq: number
  chars: number
  uses: number
  last_used: number | null
  evicted: number
}

interface MatchRow {
  key: string
  seq: number
  ts: number
  kind: string
  rank: number
  snippet: string | null
  text: string | null
}

/**
 * The session index: one SQLite file in the tnega home, shared by every run
 * of this host. It is a cache over the session files and never writes them.
 * Searches bring it up to date first, reading only sessions that changed.
 * Its size is bounded: when it holds more than `maxChars` of text, the
 * sessions used least are dropped; naming a dropped session (search inside
 * it, read it) indexes it again.
 */
export class SqliteSessionIndex {
  readonly path: string
  private readonly maxChars: number
  private readonly keepUsedWithinMs: number
  private readonly now: () => number
  private db: DatabaseSync | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(options: SqliteSessionIndexOptions = {}) {
    this.path = options.path ?? join(resolveTnegaHome(), 'session-index.sqlite')
    this.maxChars = options.maxChars ?? DEFAULT_MAX_INDEXED_CHARS
    this.keepUsedWithinMs = options.keepUsedWithinMs ?? DEFAULT_KEEP_USED_MS
    this.now = options.now ?? Date.now
  }

  searchSessions(request: SessionSearchRequest): Promise<SessionSearchResult> {
    return this.serial(async db => {
      const workspaces = uniqueWorkspaces(request.workspaces)
      for (const workspace of workspaces) await this.reconcileWorkspace(db, workspace)
      this.evict(db)
      const filter = compileQuery(request.query)
      const rows = this.matchRows(db, filter, {
        sql: 's.workspace_key IN (SELECT value FROM json_each(?)) AND s.session_id <> ?',
        params: [JSON.stringify(workspaces.map(workspaceStorageKey)), request.excludeSessionId ?? ''],
      }, MAX_RANKED_ROWS)
      const groups = new Map<string, { score: number; matches: number; best: MatchRow }>()
      for (const row of rows) {
        // bm25 is negative, lower is better; a substring scan scores each match as 1.
        const score = (filter.match ? -row.rank : 1) * (row.kind === 'title' ? 3 : 1)
        const group = groups.get(row.key)
        if (!group) groups.set(row.key, { score, matches: 1, best: row })
        else {
          group.score += score
          group.matches += 1
          if (row.rank < group.best.rank) group.best = row
        }
      }
      const sessionRows = new Map<string, SessionRow>()
      const select = db.prepare('SELECT * FROM sessions WHERE key = ?')
      for (const key of groups.keys()) {
        const row = sessionRow(select.get(key))
        if (row) sessionRows.set(key, row)
      }
      const ranked = [...groups.entries()]
        .filter(([key]) => sessionRows.has(key))
        .sort(([a, left], [b, right]) => right.score - left.score
          || (sessionRows.get(b)?.updated_at ?? 0) - (sessionRows.get(a)?.updated_at ?? 0))
      const sessions: SessionMatch[] = ranked.slice(0, request.limit).map(([key, group]) => {
        const session = sessionRows.get(key)!
        return {
          workspace: session.workspace,
          sessionId: session.session_id,
          title: session.title,
          updatedAt: session.updated_at,
          matches: group.matches,
          snippet: snippetOf(group.best, filter),
          seq: group.best.seq,
          kind: textKind(group.best.kind),
        }
      })
      this.markUsed(db, sessions.map(session => keyOf(session.workspace, session.sessionId)), USE.listed)
      return { sessions, capped: ranked.length > request.limit || rows.length >= MAX_RANKED_ROWS }
    })
  }

  searchEvents(request: SessionEventSearchRequest): Promise<SessionEventSearchResult> {
    return this.serial(async db => {
      const session = await this.ensureIndexed(db, request.session)
      const filter = compileQuery(request.query)
      const scope = { sql: 's.key = ?', params: [session.key] }
      const rows = this.matchRows(db, filter, scope, request.limit)
      const total = this.countRows(db, filter, scope)
      this.markUsed(db, [session.key], USE.searched)
      const hits: SessionEventMatch[] = rows
        .sort((a, b) => a.seq - b.seq)
        .map(row => ({ seq: row.seq, ts: row.ts, kind: textKind(row.kind), snippet: snippetOf(row, filter) }))
      return { title: session.title, hits, total }
    })
  }

  read(request: SessionReadRequest): Promise<SessionReadResult> {
    return this.serial(async db => {
      const session = await this.ensureIndexed(db, request.session)
      this.markUsed(db, [session.key], USE.read)
      const events = await readSessionEventsReadOnly(session.workspace, session.session_id)
      const entries: SessionReadEntry[] = []
      for (const event of events) {
        const text = sessionEventText(event, READ_EVENT_CHARS)
        if (text) entries.push({ seq: event.seq, ts: event.ts, ...text })
      }
      let start: number
      let end: number
      if (request.around !== undefined) {
        const center = entries.findIndex(entry => entry.seq >= request.around!)
        const at = center < 0 ? entries.length - 1 : center
        start = Math.max(0, at - Math.floor(request.limit / 2))
        end = Math.min(entries.length, start + request.limit)
        start = Math.max(0, end - request.limit)
      } else {
        const before = request.before
        end = before === undefined ? entries.length : entries.filter(entry => entry.seq < before).length
        start = Math.max(0, end - request.limit)
      }
      return {
        title: session.title,
        entries: entries.slice(start, end),
        ...(start > 0 ? { earlierBefore: entries[start]!.seq } : {}),
        ...(end < entries.length ? { laterAround: entries[end]!.seq } : {}),
      }
    })
  }

  async locate(sessionId: string, workspaces: readonly string[]): Promise<SessionRef | undefined> {
    if (!isSessionId(sessionId)) return undefined
    for (const workspace of uniqueWorkspaces(workspaces)) {
      const info = await stat(join(sessionDir(workspace), `${sessionId}.jsonl`)).catch(() => undefined)
      if (info?.isFile()) return { workspace, sessionId }
    }
    return undefined
  }

  /** Index size and contents, for tests and diagnostics. */
  stats(): Promise<{ sessions: number; evicted: number; chars: number }> {
    return this.serial(async db => {
      const row = db.prepare('SELECT count(*) AS sessions, coalesce(sum(evicted), 0) AS evicted, coalesce(sum(chars), 0) AS chars FROM sessions').get()
      return { sessions: num(row?.sessions), evicted: num(row?.evicted), chars: num(row?.chars) }
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.queue.catch(() => undefined)
    this.db?.close()
    this.db = undefined
  }

  /** One operation at a time: the database calls are synchronous, the file reads between them are not. */
  private serial<T>(run: (db: DatabaseSync) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.closed) throw new SessionSearchError('session index is closed', 'SESSION_SEARCH_UNAVAILABLE')
      return run(await this.open())
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  private async open(): Promise<DatabaseSync> {
    if (this.db) return this.db
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch (error) {
      throw new SessionSearchError(`session search needs node:sqlite: ${error instanceof Error ? error.message : String(error)}`, 'SESSION_SEARCH_UNAVAILABLE')
    }
    await mkdir(dirname(this.path), { recursive: true })
    const db = new sqlite.DatabaseSync(this.path)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      const version = num(db.prepare('PRAGMA user_version').get()?.user_version)
      if (version !== SCHEMA_VERSION) {
        // A cache: an older layout is thrown away and rebuilt.
        db.exec('DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS sessions;')
        db.exec('PRAGMA auto_vacuum = INCREMENTAL')
        db.exec('VACUUM')
      }
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          key TEXT PRIMARY KEY,
          workspace TEXT NOT NULL,
          workspace_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          file_size INTEGER NOT NULL,
          file_mtime REAL NOT NULL,
          last_seq INTEGER NOT NULL,
          chars INTEGER NOT NULL,
          uses REAL NOT NULL DEFAULT 0,
          last_used INTEGER,
          evicted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions (workspace_key);
        CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
          text, key UNINDEXED, seq UNINDEXED, ts UNINDEXED, kind UNINDEXED,
          tokenize = 'trigram'
        );
      `)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
    return db
  }

  /** Brings one workspace's sessions up to date, skipping dropped ones that have not changed. */
  private async reconcileWorkspace(db: DatabaseSync, workspace: string): Promise<void> {
    const workspaceKey = workspaceStorageKey(workspace)
    const dir = sessionDir(workspace)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      entries = []
    }
    const present = new Set<string>()
    const select = db.prepare('SELECT * FROM sessions WHERE key = ?')
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const sessionId = entry.slice(0, -'.jsonl'.length)
      if (!isSessionId(sessionId)) continue
      const key = keyOf(workspace, sessionId)
      present.add(key)
      const info = await stat(join(dir, entry)).catch(() => undefined)
      if (!info) continue
      const row = sessionRow(select.get(key))
      if (row && row.file_size === info.size && row.file_mtime === info.mtimeMs) continue
      await this.indexSession(db, { workspace, sessionId }, workspaceKey, info, row)
    }
    for (const row of db.prepare('SELECT key FROM sessions WHERE workspace_key = ?').all(workspaceKey)) {
      const key = str(row.key)
      if (!present.has(key)) this.forget(db, key)
    }
  }

  /** Indexes a session named explicitly, even one that was dropped. */
  private async ensureIndexed(db: DatabaseSync, ref: SessionRef): Promise<SessionRow> {
    const workspace = resolve(ref.workspace)
    const key = keyOf(workspace, ref.sessionId)
    if (!isSessionId(ref.sessionId)) throw new SessionSearchError(`not a session id: ${ref.sessionId}`, 'SESSION_NOT_FOUND')
    const info = await stat(join(sessionDir(workspace), `${ref.sessionId}.jsonl`)).catch(() => undefined)
    if (!info?.isFile()) {
      this.forget(db, key)
      throw new SessionSearchError(`no session ${ref.sessionId} in ${workspace}`, 'SESSION_NOT_FOUND')
    }
    let row = sessionRow(db.prepare('SELECT * FROM sessions WHERE key = ?').get(key))
    if (!row || row.evicted || row.file_size !== info.size || row.file_mtime !== info.mtimeMs) {
      await this.indexSession(db, { workspace, sessionId: ref.sessionId }, workspaceStorageKey(workspace), info, row?.evicted ? undefined : row)
      row = sessionRow(db.prepare('SELECT * FROM sessions WHERE key = ?').get(key))
    }
    if (!row) throw new SessionSearchError(`no session ${ref.sessionId} in ${workspace}`, 'SESSION_NOT_FOUND')
    return row
  }

  /**
   * Sessions only grow by appending, so a session that grew is indexed from
   * its last indexed event on. One that shrank (rewound) or was dropped is
   * indexed again from the start.
   */
  private async indexSession(
    db: DatabaseSync,
    ref: SessionRef,
    workspaceKey: string,
    info: { size: number; mtimeMs: number },
    previous: SessionRow | undefined,
  ): Promise<void> {
    let events: SessionEvent[]
    try {
      events = await readSessionEventsReadOnly(ref.workspace, ref.sessionId)
    } catch {
      return
    }
    const key = keyOf(ref.workspace, ref.sessionId)
    const append = previous !== undefined && !previous.evicted && info.size > previous.file_size
    const fromSeq = append ? previous.last_seq : 0
    const title = foldSessionMeta(events).title ?? 'New session'
    const head = events.find(event => event.type === 'meta')
    const headCreated = head?.type === 'meta' ? head.payload.createdAt : undefined
    const createdAt = typeof headCreated === 'number' ? headCreated : info.mtimeMs
    const insert = db.prepare('INSERT INTO docs (text, key, seq, ts, kind) VALUES (?, ?, ?, ?, ?)')
    db.exec('BEGIN')
    try {
      if (append) db.prepare("DELETE FROM docs WHERE key = ? AND kind = 'title'").run(key)
      else db.prepare('DELETE FROM docs WHERE key = ?').run(key)
      insert.run(title, key, 0, createdAt, 'title')
      let chars = append ? previous.chars - previous.title.length + title.length : title.length
      let lastSeq = fromSeq
      for (const event of events) {
        if (event.seq <= fromSeq) continue
        lastSeq = Math.max(lastSeq, event.seq)
        const text = sessionEventText(event, INDEXED_EVENT_CHARS)
        if (!text) continue
        insert.run(text.text, key, event.seq, event.ts, text.kind)
        chars += text.text.length
      }
      db.prepare(`
        INSERT INTO sessions (key, workspace, workspace_key, session_id, title, updated_at, file_size, file_mtime, last_seq, chars, uses, last_used, evicted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (key) DO UPDATE SET
          workspace = excluded.workspace, title = excluded.title, updated_at = excluded.updated_at,
          file_size = excluded.file_size, file_mtime = excluded.file_mtime, last_seq = excluded.last_seq,
          chars = excluded.chars, evicted = 0
      `).run(
        key, ref.workspace, workspaceKey, ref.sessionId, title, Math.round(Math.max(createdAt, info.mtimeMs)),
        info.size, info.mtimeMs, lastSeq, chars, 0, null,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private forget(db: DatabaseSync, key: string): void {
    db.prepare('DELETE FROM docs WHERE key = ?').run(key)
    db.prepare('DELETE FROM sessions WHERE key = ?').run(key)
  }

  private markUsed(db: DatabaseSync, keys: readonly string[], weight: number): void {
    const update = db.prepare('UPDATE sessions SET uses = uses + ?, last_used = ? WHERE key = ?')
    for (const key of keys) update.run(weight, this.now(), key)
  }

  /**
   * Keeps the index under `maxChars`. Sessions are dropped by how much they
   * were used, fewest uses first, and only then by how long ago; a session
   * used within `keepUsedWithinMs` stays. Each pass halves every count, so
   * use long ago counts for less than use now.
   */
  private evict(db: DatabaseSync): void {
    const total = num(db.prepare('SELECT coalesce(sum(chars), 0) AS total FROM sessions WHERE evicted = 0').get()?.total)
    if (total <= this.maxChars) return
    const target = this.maxChars * 0.8
    const candidates = db.prepare(`
      SELECT key, chars FROM sessions
      WHERE evicted = 0 AND coalesce(last_used, 0) < ?
      ORDER BY uses ASC, coalesce(last_used, 0) ASC, updated_at ASC
    `).all(this.now() - this.keepUsedWithinMs).map(row => ({ key: str(row.key), chars: num(row.chars) }))
    let remaining = total
    db.exec('BEGIN')
    try {
      const dropDocs = db.prepare('DELETE FROM docs WHERE key = ?')
      const mark = db.prepare('UPDATE sessions SET evicted = 1, chars = 0 WHERE key = ?')
      for (const candidate of candidates) {
        if (remaining <= target) break
        dropDocs.run(candidate.key)
        mark.run(candidate.key)
        remaining -= candidate.chars
      }
      db.exec('UPDATE sessions SET uses = uses / 2')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.exec('PRAGMA incremental_vacuum')
  }

  private matchRows(db: DatabaseSync, filter: CompiledQuery, scope: { sql: string; params: SQLInputValue[] }, limit: number): MatchRow[] {
    const rank = filter.match ? 'bm25(docs)' : '0'
    const snippet = filter.match ? "snippet(docs, 0, '**', '**', '…', 48)" : 'NULL'
    const text = filter.match ? 'NULL' : 'docs.text'
    return db.prepare(`
      SELECT docs.key AS key, docs.seq AS seq, docs.ts AS ts, docs.kind AS kind, ${rank} AS rank, ${snippet} AS snippet, ${text} AS text
      FROM docs JOIN sessions s ON s.key = docs.key
      WHERE ${filter.where} AND s.evicted = 0 AND ${scope.sql}
      ORDER BY rank, docs.seq DESC
      LIMIT ?
    `).all(...filter.params, ...scope.params, limit).map(row => ({
      key: str(row.key), seq: num(row.seq), ts: num(row.ts), kind: str(row.kind), rank: num(row.rank),
      snippet: row.snippet === null ? null : str(row.snippet), text: row.text === null ? null : str(row.text),
    }))
  }

  private countRows(db: DatabaseSync, filter: CompiledQuery, scope: { sql: string; params: SQLInputValue[] }): number {
    const row = db.prepare(`
      SELECT count(*) AS total FROM docs JOIN sessions s ON s.key = docs.key
      WHERE ${filter.where} AND s.evicted = 0 AND ${scope.sql}
    `).get(...filter.params, ...scope.params)
    return num(row?.total)
  }
}

interface CompiledQuery {
  where: string
  params: string[]
  /** Uses the full-text index (ranked); otherwise a plain substring scan. */
  match: boolean
  terms: string[]
}

/**
 * Each word of the query must appear, ignoring case. Words of three or more
 * characters use the trigram index; shorter ones (common in Chinese, such as
 * a two-character word) fall back to a substring scan. Query text is always
 * data: FTS syntax in it is quoted.
 */
function compileQuery(query: string): CompiledQuery {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].slice(0, 8)
  if (terms.length === 0) throw new SessionSearchError('query is empty', 'SESSION_SEARCH_INVALID')
  const long = terms.filter(term => [...term].length >= 3)
  const short = terms.filter(term => [...term].length < 3)
  const where: string[] = []
  const params: string[] = []
  if (long.length > 0) {
    where.push('docs MATCH ?')
    params.push(long.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND '))
  }
  for (const term of short) {
    where.push("docs.text LIKE ? ESCAPE '\\'")
    params.push(`%${term.replace(/[\\%_]/g, character => `\\${character}`)}%`)
  }
  return { where: where.join(' AND '), params, match: long.length > 0, terms }
}

function snippetOf(row: MatchRow, filter: CompiledQuery): string {
  // Trigram highlights stop at spaces: join neighbouring ones into one run.
  if (row.snippet !== null) return row.snippet.replace(/\s+/g, ' ').replaceAll('** **', ' ').trim()
  const text = (row.text ?? '').replace(/\s+/g, ' ').trim()
  const lower = text.toLowerCase()
  const term = filter.terms[0]!.toLowerCase()
  const at = Math.max(0, lower.indexOf(term))
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + term.length + 80)
  const found = text.slice(at, at + term.length)
  return `${start > 0 ? '…' : ''}${text.slice(start, at)}**${found}**${text.slice(at + term.length, end)}${end < text.length ? '…' : ''}`
}

type Row = Record<string, SQLOutputValue>

function num(value: SQLOutputValue | undefined): number {
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0
}

function str(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function sessionRow(row: Row | undefined): SessionRow | undefined {
  if (!row) return undefined
  return {
    key: str(row.key), workspace: str(row.workspace), workspace_key: str(row.workspace_key),
    session_id: str(row.session_id), title: str(row.title), updated_at: num(row.updated_at),
    file_size: num(row.file_size), file_mtime: num(row.file_mtime), last_seq: num(row.last_seq),
    chars: num(row.chars), uses: num(row.uses), last_used: row.last_used === null ? null : num(row.last_used),
    evicted: num(row.evicted),
  }
}

function textKind(kind: string): SessionTextKind {
  return kind === 'title' || kind === 'user' || kind === 'assistant' || kind === 'tool-call' || kind === 'tool-result' ? kind : 'assistant'
}

function keyOf(workspace: string, sessionId: string): string {
  return `${workspaceStorageKey(workspace)}:${sessionId}`
}

function uniqueWorkspaces(workspaces: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const entry of workspaces) {
    const workspace = resolve(entry)
    const key = workspaceStorageKey(workspace)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(workspace)
  }
  return unique
}

/** The Provider over a shared index: one index per host, one service per run. */
export class SqliteSessionSearch extends SessionSearchService {
  constructor(ctx: Context, private readonly index: SqliteSessionIndex) {
    super(ctx)
  }

  searchSessions(request: SessionSearchRequest): Promise<SessionSearchResult> { return this.index.searchSessions(request) }
  searchEvents(request: SessionEventSearchRequest): Promise<SessionEventSearchResult> { return this.index.searchEvents(request) }
  read(request: SessionReadRequest): Promise<SessionReadResult> { return this.index.read(request) }
  locate(sessionId: string, workspaces: readonly string[]): Promise<SessionRef | undefined> { return this.index.locate(sessionId, workspaces) }
}

/** `await ctx.plugin(sessionSearchSqlite, { index })`; the host owns and closes the index. */
export const sessionSearchSqlite = {
  name: 'session-search-sqlite',
  apply(ctx: Context, config: { index: SqliteSessionIndex }) {
    new SqliteSessionSearch(ctx, config.index)
  },
}

export const name = '@tnega/session-search-sqlite'

import type { SqlClient } from './sql.js'

/**
 * The tables the Session store reads and writes, exactly as
 * `docs/plans/v2-server-mvp.md` §3.2 defines them, so a database seeded from
 * that file and one this bootstrap creates are the same. Every statement is
 * idempotent: running it on a seeded database changes nothing.
 */
const TABLES = [
  `create table if not exists account (id uuid primary key, name text not null, created_at timestamptz not null default now())`,
  `create table if not exists device (
    id uuid primary key, account_id uuid not null references account,
    kind text not null check (kind in ('client','daemon')),
    name text not null, token_hash bytea not null unique,
    protocol_version int, capabilities jsonb, last_seen timestamptz,
    revoked_at timestamptz
  )`,
  `create table if not exists workspace (
    id uuid primary key, account_id uuid not null references account,
    kind text not null check (kind in ('daemon_path','git')),
    daemon_id uuid references device,
    path text, repo_url text, branch text,
    check ((kind = 'daemon_path' and daemon_id is not null and path is not null and repo_url is null and branch is null)
        or (kind = 'git' and repo_url is not null and daemon_id is null and path is null))
  )`,
  `create table if not exists session (
    id uuid primary key, workspace_id uuid not null references workspace,
    account_id uuid not null references account,
    meta jsonb not null default '{}',
    head_seq bigint not null default -1,
    lease_owner text, lease_until timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  )`,
  `create table if not exists session_event (
    session_id uuid not null references session on delete cascade,
    event jsonb not null,
    seq bigint generated always as ((event->>'seq')::bigint) stored,
    event_id text generated always as (event->>'id') stored,
    type text generated always as (event->>'type') stored,
    content_hash bytea not null,
    primary key (session_id, seq),
    unique (session_id, event_id)
  )`,
  // Not in §3.2: one workspace row per folder on a daemon, so resolving a
  // folder twice (two servers at once) cannot make two.
  `create unique index if not exists workspace_daemon_path on workspace (daemon_id, path) where kind = 'daemon_path'`,
  `create index if not exists session_workspace_updated on session (workspace_id, updated_at desc)`,
]

/** Create the store's tables when they are missing. Safe to run from several servers at once. */
export async function bootstrapSchema(sql: SqlClient): Promise<void> {
  await sql.transaction(async tx => {
    // Two servers starting together would race on `create table if not exists`.
    await tx.query(`select pg_advisory_xact_lock(7104553551)`)
    for (const statement of TABLES) await tx.query(statement)
  })
}

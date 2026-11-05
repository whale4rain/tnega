# Tnega server MVP: state and control

> 状态：进行中（提案，2026-11-04，基线 0.5.6）
> 取代关系：无
> 当前实现：尚未实现；本地现状见 `packages/session/README.md`、`packages/session-store/src/index.ts`、`packages/project/blackboard-local/README.md`、`packages/runtime/src/compose.ts`

This is the detailed design for the server half of [v2-plan.md](v2-plan.md):
where state lives, how the control loops work, and what the first version
includes. It assumes the decided shape: a headless **tnega server** (runtime,
state, control) and **daemons** that own files, commands and environments.

## 1. MVP scope

**In:**

- One server instance (one container), one Postgres, one blob directory.
- One owner account, device tokens for clients and daemons.
- Sessions on a local daemon (your laptop) or in a microVM box the server starts
  on E2B's open-source runtime ([ADR 0018](../adr/0018-microvm-box-layer.md)).
- Durable jobs, the effects queue, routines with no window open.
- Import of existing `~/.tnega` sessions.

**Out (later):** several server instances, several people, an Agent Substrate
(Kubernetes) box Provider, snapshots, laptop/server hand-off, S3, Projects on the server (that is
M4, right after the MVP).

Elastic in the MVP means **boxes** scale up and down; the server itself is one
instance. Section 6 says how it scales out later without a redesign.

## 2. Storage choice

| Option | For | Against | Verdict |
|---|---|---|---|
| Postgres | Row locks and `FOR UPDATE SKIP LOCKED` for queues, `LISTEN/NOTIFY` for live fan-out, JSONB for event payloads, works with several server instances, standard to host | One more container | **Server store** |
| SQLite | Zero setup, one file | One writer; cannot be shared by several server instances; would be replaced before scale-out | Not for the server |
| JSONL + files (today) | Already works, offline | Single machine, no queries | **Local mode stays on it** |

Earlier drafts said "SQLite first". The server is the thing that must scale
out, so it starts on Postgres; local mode keeps its files. Both sit behind the
same seams, so nothing above them knows which one is used.

Blobs (images, spills, uploads, artifacts) go to a content-addressed blob
store: a directory on a volume in the MVP, S3-compatible storage later. The
database keeps only hashes.

Code-layer tests can run the Postgres Providers on PGlite (Postgres compiled to
WebAssembly) so `pnpm test` needs no Docker; a host-layer `*.e2e.test.ts` runs
against a real Postgres.

## 3. State

### 3.1 Seams

| Seam | Definition | Local Provider | Server Provider |
|---|---|---|---|
| Session store | `ctx.sessionStore` (new) | JSONL files (today's `session-store`) | `session-store-pg` |
| Blackboard | `ctx.blackboard` (exists) | `blackboard-local` | `blackboard-pg` |
| Blobs | `ctx.blobs` (new) | directory under `~/.tnega` | directory or S3 |
| Jobs | `ctx.jobs` (exists) | in memory | `jobs-pg` (durable records) |

The Session event format does not change: a row holds exactly one of today's
JSONL lines (`id`, `seq`, `ts`, `type`, `payload`, `surfaceOp`,
`sourceEventSeqs`). Export to JSONL and import from it are lossless, which is
also how the local-to-server import works.

### 3.2 Schema (MVP)

```sql
-- identity
create table account (id uuid primary key, name text not null, created_at timestamptz not null default now());
create table device (
  id uuid primary key, account_id uuid not null references account,
  kind text not null check (kind in ('client','daemon')),
  name text not null, token_hash bytea not null unique,
  protocol_version int, capabilities jsonb, last_seen timestamptz,
  revoked_at timestamptz
);

-- where work happens
create table workspace (
  id uuid primary key, account_id uuid not null references account,
  kind text not null check (kind in ('daemon_path','git')),
  daemon_id uuid references device,       -- daemon_path: a folder on that daemon
  path text, repo_url text, branch text,  -- git: cloned into a box
  check ((kind = 'daemon_path' and daemon_id is not null and path is not null and repo_url is null and branch is null)
      or (kind = 'git' and repo_url is not null and daemon_id is null and path is null))
);
-- daemon_id must name a device of kind 'daemon': checked by the API on insert
-- (a composite FK on (id, kind) is possible but adds a column for little gain).
create table environment (
  id uuid primary key, workspace_id uuid not null unique references workspace on delete cascade,  -- one per workspace
  spec jsonb not null, spec_hash text not null,
  approved_hash text, approved_at timestamptz   -- setup secrets only when spec_hash = approved_hash
);
create table machine (   -- a "box" in the diagrams
  id uuid primary key, workspace_id uuid not null references workspace,
  provider text not null,                  -- 'e2b' in the MVP
  state text not null check (state in ('starting','ready','sleeping','stopped','lost')),
  daemon_id uuid references device, provider_ref text,   -- E2B sandbox id
  last_active timestamptz not null default now()
);

-- sessions: the log is the truth
create table session (
  id uuid primary key, workspace_id uuid not null references workspace,
  account_id uuid not null references account,
  meta jsonb not null default '{}',        -- folded title/model/permission, for lists
  head_seq bigint not null default -1,     -- last committed seq
  lease_owner text, lease_until timestamptz,   -- which runtime may append
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table session_event (
  session_id uuid not null references session on delete cascade,
  event jsonb not null,                        -- the whole JSONL line: the only source
  seq bigint generated always as ((event->>'seq')::bigint) stored,
  event_id text generated always as (event->>'id') stored,
  type text generated always as (event->>'type') stored,
  content_hash bytea not null,                 -- sha-256 of the canonical event, for retry checks
  primary key (session_id, seq),
  unique (session_id, event_id)
);

-- projects
create table project (id uuid primary key, account_id uuid not null references account, title text not null);
create table fact (
  project_id uuid not null references project on delete cascade,
  kind text not null, id text not null, version int not null,
  seq bigserial, record jsonb not null,        -- today's FactRecord
  primary key (project_id, kind, id)
);

-- blobs
create table blob (hash text primary key, size bigint not null, media_type text not null, created_at timestamptz not null default now());
create table blob_ref (blob_hash text not null references blob, owner_kind text not null, owner_id uuid not null,
  primary key (blob_hash, owner_kind, owner_id));

-- control
create table job (
  id uuid primary key, session_id uuid not null references session on delete cascade,
  daemon_id uuid references device, kind text not null,
  state text not null check (state in ('running','stopping','completed','failed','killed','lost')),
  started_at timestamptz not null, ended_at timestamptz, result jsonb
);
create table effect (
  id bigserial primary key, kind text not null, key text not null,
  payload jsonb not null, due_at timestamptz not null default now(),
  attempts int not null default 0, last_error text,
  unique (kind, key)
);
create table schedule (
  id uuid primary key, project_id uuid not null references project on delete cascade,
  routine_id text not null,                    -- the Blackboard routine fact id
  spec jsonb not null, next_run_at timestamptz not null,
  unique (project_id, routine_id)              -- mirroring is an upsert
);
create table secret (
  id uuid primary key, account_id uuid not null references account,
  name text not null, ciphertext bytea not null, key_id text not null,
  unique (account_id, name)
);
create table audit (id bigserial primary key, at timestamptz not null default now(),
  actor text not null, action text not null, target text, detail jsonb);
```

### 3.3 Appending to a session

One transaction:

1. `select seq, event_id from session_event where session_id = $1 and event_id = any($ids)`.
   If every event is already stored **and** each stored `content_hash` equals
   the incoming one, this is a retry: answer `committed` with the stored seqs
   and stop. If only some are stored, or an id is reused with different
   contents, answer `conflict` (a batch is all or nothing). Tests cover exact
   retry, changed payload and partial overlap.
2. `update session set head_seq = head_seq + n, updated_at = now() where id = $1 and head_seq = $expected and lease_owner = $me returning head_seq`.
   No row means `conflict`: answer with the current `head_seq`.
3. `insert into session_event ...` with seqs `$expected + 1 … $expected + n`.
   The unique `(session_id, event_id)` is a backstop: a duplicate here aborts
   the transaction, so `head_seq` never moves without its rows and there are no
   gaps.
4. `notify session_events, '<session id>:<head_seq>'` so other connections can
   push it to clients.

The lease replaces today's pid + hostname lock file (`packages/session/src/lock.ts`):
the runtime that owns a session renews `lease_until` every 5 seconds, and a lease
untouched for 30 seconds can be taken over, the same numbers the lock file uses
today (`HEARTBEAT_MS`, `STALE_MS`).

Append-only is enforced by grants, not only by code: the server's database role
has `INSERT` and `SELECT` on `session_event` and no `UPDATE` or `DELETE`;
deleting a session runs under a separate admin role. Event payloads over about
2 KB are compressed by Postgres (TOAST), and large tool outputs already spill to
the blob store. `NOTIFY` payloads are capped at 8 KB, so they carry only
`session:seq`. If the table grows to hundreds of millions of rows it is
partitioned by a hash of `session_id`; the MVP does not need it.

### 3.4 What the server stores about a workspace

Tool results in the log quote file contents, so the server does hold workspace
excerpts. MVP rules: only the owner account reads its sessions; deleting a
session deletes its events, its jobs and its `blob_ref` rows (a sweep removes
blobs with no refs); the Postgres volume and blob directory sit on an encrypted
disk. Per-member access arrives with multi-person projects.

## 4. Control

### 4.1 Processes

`tnega server` is one Node process with four parts:

| Part | Does |
|---|---|
| API | HTTP + SSE for clients (today's routes, now behind auth); WebSocket JSON-RPC for daemons |
| Runtimes | One resident `createAgentRuntime` per active session, as today, with the Postgres session store and remote `ctx.fs` / `ctx.process` bound to that session's daemon |
| Control loop | Every 2 seconds and on demand: due effects, due schedules, idle boxes, lost daemons |
| Machine Provider | Starts, pauses, resumes and kills microVM boxes through the E2B runtime API |

### 4.2 Effects: store first, act after

Every outside action is written to `effect` in the same transaction as the
decision that causes it, and carried out after commit (pattern from
dsh-superagent's `Effects`). The loop takes due rows with
`select ... for update skip locked`, runs them, deletes them on success and on
failure sets `due_at` with backoff from 2 seconds doubling to 60. Three failures
in a row show as a problem in Settings.

A crash after the outside action succeeds but before the row is deleted runs the
effect again, so every handler must be safe to repeat. The rule: each effect has
a stable `kind` + `key`, the handler passes the key to the outside system, and
the outside system answers a repeat with the first result. For `machine.start`
the key is the `machine` row id: the E2B Machine Provider puts it in the
sandbox metadata together with the environment's `spec_hash`. `start` first
looks for a sandbox (running or paused) with that id: if its `spec_hash`
matches, a repeat returns the same box instead of a second one; if the spec
changed, the old box is saved as a work bundle (§4.7) and killed, and a new box
is made from the new template, so setup secrets from an old spec never carry
over in a paused box's memory or disk.

| Kind | Does |
|---|---|
| `machine.start` / `machine.stop` | Ask the Machine Provider for a box, or release one |
| `run.wake` | Start a turn for a session whose inbox has input (a routine, a project message) |
| `notify` | Send a client notification |
| `blob.sweep` | Delete unreferenced blobs |

Tool calls to a daemon are not effects: they are part of a turn, and a dropped
daemon ends the call the way a crash does today (the turn closes as
`interrupted`; `findInterruptedTurn` decides whether it can resume).

### 4.3 Daemons

1. A daemon starts with a device token (`tnega daemon --server URL`, or the
   token the Machine Provider put in the container) and opens the WebSocket.
2. Handshake: `{ protocolVersion, deviceId, capabilities, workspaces }`. The
   server refuses versions outside N and N-1 and records the rest in `device`.
3. Heartbeat every 10 seconds. After 30 seconds without one the daemon is
   `lost`: its in-flight calls fail as not started or interrupted, its jobs
   become `lost`, and a box's `machine` row moves to `lost` and gets a `machine.start` effect
   if a session still needs it.

### 4.4 Boxes

In code a box is a **machine** (`ctx.machines`, `MachineProvider`), because
`ctx.box` already names the Project message channel (`packages/project/box`).
The diagrams keep the word box.

```ts
interface MachineProvider {
  // key = machine row id. A second start with the same key returns the same box
  // when its spec_hash matches (a paused box is resumed, not recreated);
  // a different spec_hash replaces the box (§4.2). Every start that returns a
  // box also makes sure `tnega daemon` runs in it: if the daemon is gone it is
  // relaunched with a fresh one-time token and the old token is revoked
  start(key: string, spec: BoxSpec): Promise<{ ref: string }>   // template, env, resources, isolation, one-time daemon token
  pause(ref: string): Promise<void>                              // keep memory and disk
  stop(ref: string): Promise<void>                               // kill and release
  status(ref: string): Promise<'running' | 'paused' | 'exited' | 'missing'>
}
// BoxSpec.isolation: 'microvm' in the MVP; a Provider that cannot give the
// asked level fails with SANDBOX_UNAVAILABLE
```

The first Provider is `machine-e2b` on E2B's open-source runtime
(`e2b-dev/runtime`, Firecracker). Boxes are restored from a snapshot instead
of booted, and a paused box keeps its memory, so its shell, dev server and
jobs are still running when it resumes. The same Provider talks to a
self-hosted runtime or to E2B's cloud by URL. Docker boxes are not built
([ADR 0018](../adr/0018-microvm-box-layer.md)).

Lifecycle: `starting` (sandbox created from the environment's template; the
template's setup step ran with the approved secrets and the registry
allowlist) → `ready` (daemon connected; agent phase under the network policy)
→ `sleeping` after the environment's idle timeout (sandbox paused, memory and
disk kept) → `ready` again on the next message → `stopped` when the workspace
is deleted or the paused box is reclaimed (§4.7). Only the server writes
`machine.state`; Provider answers map to it as `running` + daemon connected →
`ready`, `running` without a daemon → `starting`, `paused` → `sleeping`,
`exited` or `missing` while a session needs the box → `lost` (and a
`machine.start` effect), `missing` after a `stop` → `stopped`. A daemon that
misses heartbeats moves a `ready` row to `lost` even if the Provider still says
`running`. The MVP caps running boxes
per account (default 4) and queues the rest, like dsh-superagent's worker
slots, with one extra slot so a person's message is never stuck behind new
work.

### 4.7 Headless runs

A headless run is a turn with no client open: a routine, a Project thread, or a
session the person left. The agent loop stays in the server; the box only does
files and commands, so the server tracks two lifecycles separately.

- **Run** (in the server, rebuilt from the Session log): `unloaded` → `queued`
  → `running` → `waiting` (approval, question, secret request) → `idle` →
  `unloaded`. A waiting run keeps no box running: the box pauses and resumes
  when the person answers.
- **Start**: every wake is a `run.wake` effect. The server resumes the box and
  starts the first model call together. Queue order when slots are full: a
  person's message, then a resumed approval, then a Project thread message,
  then a routine.
- **Idle**: the in-memory runtime unloads after 10 idle minutes. A box pauses
  after 5 minutes with no tool call, open terminal or running job. A paused box
  is kept 7 days; before it is reclaimed the server saves a work bundle to the
  blob store. The work bundle has two parts: a `git bundle` of local commits,
  and a separate archive of uncommitted and untracked files.
- **Boxes are for `git` workspaces only.** A `daemon_path` workspace lives on
  the person's own daemon and never gets a box; the API refuses to create a
  `machine` row for one, so restore always has a `repo_url` to start from.
- **No secrets in a bundle**: the bundle covers only the workspace folder, and
  setup secrets exist only in the setup step's environment. Before saving, the
  server checks the archive for the exact values in the secret store; a file
  that contains one is left out and named in the restore note. Restore refuses
  a bundle that still contains a secret value.
- **Restore**: the next box for that workspace clones `repo_url` at `branch`
  as usual, fetches the local commits from the `git bundle` and checks out the
  saved HEAD, then unpacks the archive over the working tree. Only after both
  steps succeed is the bundle marked used; it stays in the blob store for 7
  more days. If a step fails, the box start fails with the reason, the box is
  not marked `ready`, the bundle is kept for a retry, and the person sees the
  error instead of an empty workspace.
- **Limits**: a headless turn has a wall-time cap (default 60 minutes) and a
  routine run a token budget; the loop guard and continuation nudge apply;
  nothing that asks is auto-approved.
- **Crashes**: a lost daemon ends its calls as interrupted (§4.3); a server
  restart reloads runs from the log and `findInterruptedTurn` decides whether a
  turn resumes; paused boxes are untouched.
- **Secrets**: model keys never enter a box; the egress proxy adds git and API
  keys, and the box's E2B egress rule allows only the proxy. To add a key the
  proxy terminates TLS for the hosts that get one: it presents a certificate
  from a per-deployment CA that only the box template trusts, opens its own
  TLS connection upstream with normal certificate validation, adds the key,
  and drops it if a redirect leaves the host. Hosts that get no key stay
  plain CONNECT tunnels that the proxy does not open.

### 4.5 Scheduler

Routines are already Blackboard facts. The server mirrors each into `schedule`
with its `next_run_at`, keyed by `(project_id, routine_id)` so a repeated
mirror updates the same row. One transaction claims a due row
(`for update skip locked`), advances `next_run_at` and inserts the `run.wake`
effect with key `routine_id:<run time>`, so a routine cannot run twice for the
same time. This removes today's limit that routines run
only while their project is open.

### 4.6 Identity and secrets

- MVP: one owner account created by `tnega server init`, which prints a pairing
  code. `tnega login URL` on a client or `tnega daemon --server URL` exchanges
  the code for a device token. Tokens are stored hashed; revoking sets
  `revoked_at`.
- Pairing codes are random (at least 128 bits), single-use, valid for 10
  minutes and bound to one device kind (client or daemon). Exchanges are rate
  limited per source address (5 failures a minute, then a lockout). Tests cover
  failed, expired, reused and rate-limited exchanges.
- The API checks that the caller's account owns a session before it calls
  `ctx.sessionStore`; the store itself takes no principal. Several accounts will
  need their own ownership tests.
- Secrets are encrypted with AES-256-GCM under a master key from the server's
  environment (`TNEGA_MASTER_KEY`). Model keys are used by the server's own
  model calls; git and API keys reach a box only through the egress proxy.

## 5. Deployment

```yaml
# deploy/compose.yaml (sketch)
services:
  server:   { image: ghcr.io/whale4rain/tnega-server, ports: ["8765:8765"],
              volumes: [blobs:/data/blobs],
              environment: [DATABASE_URL, TNEGA_MASTER_KEY, E2B_API_URL, E2B_API_KEY] }
  postgres: { image: postgres:17, volumes: [pg:/var/lib/postgresql/data] }
  proxy:    { image: ghcr.io/whale4rain/tnega-egress }
# boxes are microVMs on E2B's open-source runtime, on the same or another
# Linux host with KVM; each box's egress rule allows only the proxy
```

- **Transport:** the server serves HTTPS itself, or runs behind a TLS reverse
  proxy with port 8765 bound to a private interface. Clients and daemons refuse
  `http://` and `ws://` URLs except to `localhost`, before sending any code or
  token, and check the certificate.
- **Box network fails closed:** if the Machine Provider cannot set the box's
  egress rule to the proxy only, the box start fails with
  `SANDBOX_UNAVAILABLE`; it never falls back to open egress. An unrestricted
  box is an explicit opt-in in the environment spec, like `bypass` today.
- **Box host:** E2B's runtime needs Linux with KVM (a dedicated server or a
  cloud VM with nested virtualization). Its one-host package is meant for
  evaluation; production uses its multi-host setup. The server mounts no
  Docker socket, which removes that path to control its host; it holds an E2B
  API key scoped to its own sandboxes. The server's own user, capabilities and
  mounts are set in its image and checked by a deploy test.

## 6. Scaling out later

- Several server instances share Postgres. A session is served by the instance
  that holds its lease; others route its client to that instance, or relay its
  live stream through `LISTEN/NOTIFY`.
- The control loop already uses `skip locked`, so several instances can run it.
- Blobs move to S3; the E2B runtime moves from one host to its multi-host setup,
  or an Agent Substrate Provider is added for a large hosted fleet.

## 7. Build order

Before M3 the seams exist with local Providers (see the v2 plan, steps 1–5).
The server MVP is then:

1. Schema and migrations; `session-store-pg`, `blackboard-pg`, `blobs` on
   PGlite in tests.
2. `tnega server` with auth, client routes, daemon WebSocket and the local
   daemon from the laptop.
3. Effects queue and control loop; durable jobs.
4. E2B Machine Provider, environment approval, egress proxy.
5. Scheduler for routines; `tnega server import`.
6. `deploy/compose.yaml`, the `server-v*` release workflow and images.

## 8. Open questions

- Whether a client may hold a session open on two servers (no in the MVP).
- Box volumes: one per workspace or per session (MVP: per workspace).
- How long sleeping boxes keep their volume: decided 2026-11-05, 7 days in the
  MVP, then a work bundle and reclaim (§4.7).

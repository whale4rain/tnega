# Tnega v2: package changes

> 状态：进行中（提案，2026-11-04，基线 0.5.6）
> 取代关系：无
> 当前实现：尚未实现；现状见 `packages/fs/tool-fs/README.md`、`packages/execution/src/index.ts`、`packages/session-store/src/index.ts`、`packages/host/src/server.ts`、`packages/runtime/src/compose.ts`

This is the work list for v2: which packages change and how, which packages
are new, and the expected file layout. It turns the design in
[v2-plan.md](v2-plan.md) and [v2-server-mvp.md](v2-server-mvp.md) into work
items that can be handed off. Each phase ends with a prompt for the agent that
builds it.

**Stability is not the first promise.** v2 changes the seams, the storage and the
host split, so the 1.0 freeze waits until the v2 shape has landed. Until then,
0.x minor releases (0.6, 0.7 …) may change the Session format, seam APIs and
wire types, as long as each change ships with a migration and a test that reads
the previous format.

## Rules every phase follows

- Read `AGENTS.md`, `CONTEXT.md`, `docs/adr/0006-capability-seams.md` and the
  README of every package you touch before writing code.
- One role per package: Service Definition, Provider and Consumer live in
  separate packages in one container folder. A Consumer never imports a
  Provider; only `packages/runtime` picks Providers.
- Each new package gets `README.md`, `package.json`, `src/index.ts`, `test/`,
  and an entry in the root `package.json` `exports` plus `scripts/build.mjs`.
- Local mode must behave exactly as before after every phase: the whole code
  layer (`pnpm test`) passes, plus `pnpm typecheck` and `pnpm lint`.
- No CHANGELOG edits. Conventional Commits, subjects of 72 characters or fewer.
- Each phase is one PR, or a few, that can merge on its own.

## Overview

| Phase | Adds | Changes | Visible to users |
|---|---|---|---|
| P1 `ctx.fs` | `fs/fs`, `fs/fs-local` | `tool-fs`, `workspace-files`, `tool-send-file`, `fs-sandbox` use | No |
| P2 `ctx.process` | `process/process`, `process/process-local` | `execution` folded in; `tool-shell`, `tool-web-fetch`, `search-ripgrep`, `jobs-local`, sandbox and secrets decorators | No |
| P3 Session and blob seams | `session-store/session-store` (Definition), `session-store-jsonl`, `blobs/blobs`, `blobs/blobs-local` | `session` (`SessionLog` writes through a backend), `host` routes, `usage`, `context-insights`, `memory-dream`, `spill-local` | No |
| P4 Daemon protocol | `daemon/protocol`, `daemon/daemon`, `daemon/{fs,process,browser,computer}-remote`, `cli daemon` | `runtime/compose.ts` picks local or remote | `tnega daemon` command |
| P5 Host split | `daemon/daemon-routes` | `host/server.ts` stops mounting machine routes itself | No |
| P6 Client profiles | none | `client` (`ServerProfile`, protocol version), `apps/web`, `apps/desktop`, `tui` | Connection setting |
| P7 Server | `server/*` packages, `deploy/` | none in harness | `tnega-server` image |
| P8 Machines | `machine/*` packages, egress proxy | `sandbox-network-proxy` reused | MicroVM boxes on E2B's runtime |

P1 to P3 are the groundwork and can run in parallel. P4 needs P1 and P2. P5
needs P4. P6 can start after P3. P7 needs P3 and P4. P8 needs P7.

## Target layout

New folders and packages only; everything else stays where it is.

```text
packages/
  fs/
    fs/                 NEW  Service Definition ctx.fs
    fs-local/           NEW  Provider: node:fs, atomic write, path fence
    tool-fs/            CHANGED  uses ctx.fs, no node:fs
    search-definition/  unchanged
    search-ripgrep/     CHANGED  starts rg through ctx.process
    tool-search/        unchanged
  process/
    process/            NEW  Service Definition ctx.process (types from execution)
    process-local/      NEW  Provider: spawn, shell, HTTP, ProcessRegistry
  execution/            CHANGED  re-exports process + process-local for one release, then removed
  session-store/
    session-store/      NEW  Service Definition ctx.sessionStore
    session-store-jsonl/ NEW Provider: today's packages/session-store/src code
  blobs/
    blobs/              NEW  Service Definition ctx.blobs
    blobs-local/        NEW  Provider: content-addressed folder
  daemon/
    protocol/           NEW  JSON-RPC 2.0 message types, method table, version
    daemon/             NEW  the daemon process: serves fs/*, process/*, terminal/*, browser/*, computer/*
    daemon-routes/      NEW  machine-side HTTP routes moved out of host (files, terminal, browser, folder picker)
    fs-remote/          NEW  Provider of ctx.fs over the protocol
    process-remote/     NEW  Provider of ctx.process over the protocol
    browser-remote/     NEW  Provider of ctx.browser over the protocol
    computer-remote/    NEW  Provider of ctx.computer over the protocol
  server/               (P7, server release line)
    server/             NEW  `tnega server`: API, runtimes, control loop
    session-store-pg/   NEW  Provider of ctx.sessionStore on Postgres
    blackboard-pg/      NEW  Provider of ctx.blackboard on Postgres
    blobs-s3/           LATER
    jobs-pg/            NEW  durable job records
    auth/               NEW  accounts, devices, pairing, tokens
    control/            NEW  effects queue, scheduler, daemon registry
    db/                 NEW  schema, migrations, PGlite test helper
  machine/              (P8)
    machine/            NEW  Service Definition ctx.machines
    machine-e2b/        NEW  Provider: E2B runtime API (microVM boxes, ADR 0018)
    egress-proxy/       NEW  key-injecting proxy built on sandbox-network-proxy
deploy/
  compose.yaml          NEW
  docker/server.Dockerfile   NEW  (the server's own image)
  e2b/template/        NEW  box template: base image, setup step, tnega daemon
```

## P1 `ctx.fs`

**Why:** file tools and workspace routes call `node:fs` directly
(`packages/fs/tool-fs/src/{atomic,edit,list,read,write}.ts`,
`packages/workspace-files/src/{changes,file-edits,files,uploads,workspace-files}.ts`,
`packages/reply/tool-send-file/src/index.ts`). They need to work against a
workspace on another machine.

**New `packages/fs/fs`** (Definition, abstract Cordis `Service` owning `ctx.fs`):

```ts
interface FsStat { kind: 'file' | 'dir' | 'symlink'; size: number; mtimeMs: number }
abstract class WorkspaceFs extends Service {
  abstract stat(path: string): Promise<FsStat | undefined>
  abstract readFile(path: string, range?: { start: number; end: number }): Promise<Uint8Array>
  abstract writeFile(path: string, data: Uint8Array, options?: { mode?: 'atomic' | 'append'; expectMtimeMs?: number }): Promise<FsStat>
  abstract list(path: string, options?: { limit?: number; cursor?: string }): Promise<{ entries: FsEntry[]; cursor?: string }>
  abstract mkdir(path: string): Promise<void>
  abstract remove(path: string, options?: { recursive?: boolean }): Promise<void>
  abstract rename(from: string, to: string): Promise<void>
}
```

Paths are workspace-relative strings with `/`; the Provider maps them to
`node:path` and applies the fence. Events `fs/*` belong to this package if
any are needed (none in P1).

**New `packages/fs/fs-local`** (Provider): moves `atomic.ts` from `tool-fs`,
uses `fs-sandbox` for the fence. Files: `src/index.ts`, `src/atomic.ts`,
`src/fence.ts`, `test/fs-local.test.ts` (atomic write, append, fence escape,
symlink out of workspace, Windows-style paths).

**Changes:**

| Package | From | To |
|---|---|---|
| `fs/tool-fs` | `node:fs/promises` in `read.ts`, `write.ts`, `edit.ts`, `list.ts`; owns `atomic.ts` | `inject: ['fs']`; read-after-write guard uses `stat().mtimeMs`; `atomic.ts` moves out |
| `workspace-files` | `node:fs` for listing, diffs, uploads | `ctx.fs`; `file-search.ts` keeps using the search seam |
| `reply/tool-send-file` | reads the file with `node:fs` | `ctx.fs.readFile` |
| `runtime/compose.ts` | nothing to pick | mounts `fs-local` for every scope with a workspace |

**Out of scope:** `session`, `project/*-local`, `coding-agent` skills and MCP
config. Those read tnega's own state, not the workspace.

**Done when:** no file under `packages/fs/tool-fs/src` or
`packages/workspace-files/src` imports `node:fs`; existing tool tests pass
unchanged; new Provider tests pass on Linux and Windows.

**As built (2026-11-04):** `ctx.fs.workspace(root, { allowOutside })` returns a
`WorkspaceFs` handle, so one Provider serves every workspace of a scope (host
routes open one per request). The handle also has `resolve` (symlinks followed,
fenced again) and `realRoot`, which the file tools need for their locks and
display paths. The read-after-write guard keeps comparing content hashes
rather than `mtimeMs` (no behaviour change). `workspace-files/src/file-edits.ts`
still uses `node:fs` with `git`; it moves together with git in P2, when
commands go through `ctx.process`.

**Hand-off prompt:**

```text
You are working in the tnega repo (pnpm, TypeScript strict). Build phase P1 of
docs/plans/v2-package-changes.md: a new ctx.fs seam.
1. Read AGENTS.md, CONTEXT.md, docs/adr/0006-capability-seams.md, the README
   and src of packages/fs/tool-fs, packages/workspace-files,
   packages/sandbox/fs-sandbox and packages/reply/tool-send-file.
2. Add packages/fs/fs (Service Definition owning ctx.fs, interface as in the
   plan) and packages/fs/fs-local (Provider; move atomic.ts from tool-fs; fence
   through fs-sandbox). Add both to root package.json exports and
   scripts/build.mjs.
3. Switch tool-fs, workspace-files and tool-send-file to ctx.fs. Mount fs-local
   in packages/runtime/src/compose.ts and wherever host builds a workspace
   scope. Do not change tool names, inputs or result text.
4. Tests: Provider tests for atomic write, append, fence escape, symlink escape,
   Windows paths; keep every existing test green. Run pnpm typecheck, pnpm
   lint, pnpm test.
5. Open one PR titled "feat(fs): add ctx.fs seam with a local provider".
   Say in the description why the package is not split further.
Do not edit CHANGELOG.md. Ask before changing any tool's behaviour.
```

## P2 `ctx.process`

**Why:** `ExecutionProvider` (`packages/execution/src/index.ts:127`) is passed
by hand: `compose.ts:212` builds
`sandboxedExecution(ctx, { inner: secretEnvExecution(ctx, localExecutionProvider) })`
and hands it to tools. Promoting it to a seam lets `compose.ts` swap in a
remote Provider and keeps the decorators.

**New `packages/process/process`** (Definition owning `ctx.process`): the types
now in `execution/src/index.ts` (`ShellRequest`, `ProcessRequest`,
`HttpRequest`, `BackgroundProcess`, `ExecutionChild` …) and an abstract
`ProcessService` with `runShell`, `runProcess`, `fetchHttp`, `startShell`,
`startProcess`. `decodeOutput`, `isSandboxPipeDenial` and output limits move
with the types.

**New `packages/process/process-local`** (Provider): `localExecutionProvider`,
`shell.ts`, `network.ts`, `processes.ts` (`ProcessRegistry`),
`configureSystemShell`, `configureProcessLauncher`.

**Changes:**

| Package | From | To |
|---|---|---|
| `execution` | the whole boundary | re-exports `process` + `process-local` with `@deprecated` for one release, then removed |
| `shell/tool-shell` | receives an `ExecutionProvider` option | `inject: ['process']` |
| `web/tool-web-fetch` | same | `ctx.process.fetchHttp` |
| `fs/search-ripgrep` | runs rg through a passed provider; `binary.ts` reads with `node:fs` | `ctx.process`; binary lookup moves to the Provider side (daemon) |
| `jobs/jobs-local` | uses `ProcessRegistry` from `execution` | imports it from `process-local` |
| `sandbox/execution-sandbox`, `secrets/execution-secrets` | wrap an `ExecutionProvider` value | still decorators, of the `ProcessService` before it is provided; names unchanged |
| `runtime/compose.ts`, `runtime/builtins.ts` | builds the chain and passes it to tools | provides `ctx.process` once per scope with the decorated chain |
| `host/server.ts` | imports `configureSystemShell` from `execution` | from `process-local` |
| `auth-chatgpt`, `workspace-files/file-search.ts` | take `ExecutionProvider` | `ctx.process` |

**Done when:** `grep -r "@tnega/execution'" packages` finds only the re-export
package; sandbox and secrets tests pass unchanged; a test proves that a scope
with a sandbox never sees the raw local Provider.

**As built (2026-11-04):** `ProcessService` implements `ExecutionProvider`;
`ProcessBoundary` / the `processBoundary` plugin provide `ctx.process` from
one boundary value, so `capability:sandbox` mounts the local boundary wrapped
by the secrets and sandbox decorators, and `shell` / `http_get` take it from
`ctx.process`. `ProcessRegistry` moved to the Definition (it is machine-free).
`ExecutionProvider.describeShell()` replaces the tool's direct `systemShell()`
call. Still on `@tnega/process-local` directly, because they are machine-side
until P4/P5: `search-ripgrep` (runs `rg` on the raw local boundary, as before),
`execution-sandbox` (builds confined argv for the local shell), `workspace-files`
(`@` file search and `git`), and the host / CLI / desktop configuration calls.

**Hand-off prompt:**

```text
Build phase P2 of docs/plans/v2-package-changes.md in the tnega repo: promote
ExecutionProvider to a ctx.process seam.
1. Read AGENTS.md, docs/adr/0006 and 0008, packages/execution, packages/runtime/src/compose.ts
   and builtins.ts, packages/sandbox/execution-sandbox, packages/secrets/execution-secrets,
   and every package that imports @tnega/execution.
2. Add packages/process/process (Definition, ctx.process, types moved from
   execution) and packages/process/process-local (Provider, moved code). Keep
   packages/execution as a deprecated re-export so nothing outside breaks.
3. compose.ts provides ctx.process once per scope: local Provider wrapped by the
   secrets and sandbox decorators, in today's order. Tools use inject:['process'].
4. The sandbox must still fail closed (SANDBOX_UNAVAILABLE), and a sandboxed
   scope must never reach the undecorated Provider: add a test for that.
5. Run pnpm typecheck, lint, test. One PR: "refactor(process): promote the
   execution boundary to ctx.process". Do not edit CHANGELOG.md.
```

## P3 Session and blob seams

**Why:** `packages/session-store/src/index.ts` (904 lines) is a function
library keyed by workspace path, and `SessionLog` in
`packages/session/src/index.ts` appends to the file itself with a lock file
(`lock.ts`). Host, usage, context insights, session search and memory dream all
call it directly. The server needs the same API on Postgres.

**New `packages/session-store/session-store`** (Definition, `ctx.sessionStore`):

```ts
abstract class SessionStore extends Service {
  abstract create(options: CreateSessionOptions): Promise<SessionSummary>
  abstract list(workspace: WorkspaceRef): Promise<SessionSummary[]>
  abstract snapshot(id: string, page?: SessionPageOptions): Promise<SessionSnapshot>
  abstract read(id: string, afterSeq: number): AsyncIterable<SessionEvent>
  abstract append(id: string, expectedSeq: number, events: SessionEvent[], owner: string): Promise<{ status: 'committed'; seqs: number[] } | { status: 'conflict'; headSeq: number }>
  abstract patchMeta(id: string, patch: SessionMetaPatch): Promise<void>
  abstract lease(id: string, owner: string): Promise<Lease>   // replaces lock.ts
}
// The server API checks that the caller owns the session before calling the
// store; the store takes no principal in the single-owner MVP.
```

`WorkspaceRef` = `{ kind: 'local'; path } | { kind: 'daemon'; daemonId; path } | { kind: 'git'; repoUrl; branch }`.

**New `packages/session-store/session-store-jsonl`** (Provider): today's code,
moved; the lock file becomes the lease implementation.

**New `packages/blobs/blobs`** (Definition, `ctx.blobs`: `put(bytes, mediaType) → hash`,
`get(hash)`, `has(hash)`) and **`packages/blobs/blobs-local`** (folder under
`~/.tnega/blobs/<aa>/<hash>`).

**Changes:**

| Package | From | To |
|---|---|---|
| `session` | `SessionLog` opens and appends the file; `lock.ts` | format, invariants and rebuild stay; writing goes through a `SessionBackend` given by the store; `lock.ts` moves to the JSONL Provider |
| `session-store` (folder) | one package | becomes the container for the Definition and the JSONL Provider |
| `host` (`routes.ts`, `runs.ts`, `support.ts`) | imports functions from `@tnega/session-store` | `ctx.sessionStore` |
| `usage`, `context-insights`, `memory/memory-dream`, `session-search/session-search-sqlite` | same | `ctx.sessionStore` (search index reads through `read`) |
| `spill/spill-local` | writes spill files itself | stores bytes in `ctx.blobs` |
| inline images in Session events | base64 in the payload | new events carry a blob hash; old inline images still read (format version bump with a migration test) |

**Done when:** no package outside `session-store-jsonl` touches session files;
the Session format version bump has a test that reads version 10 files; a
replay test proves events read back equal events written.

**Hand-off prompt:**

```text
Build phase P3 of docs/plans/v2-package-changes.md in the tnega repo: the
ctx.sessionStore and ctx.blobs seams with local Providers.
1. Read AGENTS.md, CONTEXT.md (Session, Stream Event), packages/session
   (index.ts SessionLog, lock.ts, invariant.ts), packages/session-store,
   packages/spill, docs/plans/v2-server-mvp.md section 3, and every importer of
   @tnega/session-store.
2. Make packages/session-store a container: session-store (Definition, API in
   the plan, append answers committed or conflict and dedupes by event id) and
   session-store-jsonl (today's code; the lock file becomes the lease).
3. SessionLog keeps the format and invariants but writes through the store.
   Model history must still be rebuilt from durable events only.
4. Add packages/blobs/blobs and blobs-local; spill-local and new image
   attachments store bytes there. Bump SESSION_FORMAT_VERSION with a migration
   test that reads version 10 sessions.
5. Tests for append retry, duplicate event id, wrong expected seq, lease takeover
   after 30 s, and replay equality. Run typecheck, lint, test.
6. Up to three PRs (store, blobs, consumers). Do not edit CHANGELOG.md.
```

## P4 Daemon protocol

**New `packages/daemon/protocol`**: JSON-RPC 2.0 types, `PROTOCOL_VERSION`,
method table, error codes, handshake. Plain JSON only; bytes as base64 with a
size cap; long output as `process/output` notifications; cancel with
`$/cancel` by request id.

```text
initialize      { protocolVersion, deviceId, capabilities, workspaces } -> { protocolVersion, serverTime }
fs/stat fs/read fs/write fs/list fs/mkdir fs/remove fs/rename
process/run process/start process/write process/kill   + notifications process/output process/exit
http/fetch
terminal/open terminal/write terminal/resize terminal/close   + terminal/output
browser/*  computer/*   (wrap the existing Providers' methods one to one)
$/heartbeat $/cancel
```

**New `packages/daemon/daemon`**: `startDaemon({ transport, workspaces })`
serves every method by calling the local Providers (`fs-local`,
`process-local`, `terminal`, `browser-playwright`, `computer-cua`). Two
transports: in-process (a pair of message ports) and WebSocket client
(Node 22's built-in `WebSocket`; dials out, reconnects with backoff).

**New `packages/daemon/{fs,process,browser,computer}-remote`**: Providers of
`ctx.fs`, `ctx.process`, `ctx.browser` and `ctx.computer` that send protocol
calls over a connection.

**Lifecycle:** `startDaemon` returns `{ close(): Promise<void> }` and every
remote Provider and `daemon-routes` registers on its own Fiber. Close or dispose
undoes in reverse order: stop reconnect attempts, cancel in-flight calls, kill
child processes the daemon started, close the transport, unregister routes. A
test disposes mid-call and checks that no listener, timer or child process is
left.

**Workspace binding:** every `fs/*`, `process/*` and `terminal/*` call carries a
`workspaceId`. The daemon accepts only ids it announced in `initialize`, and
applies that workspace's fence; anything else fails with `WORKSPACE_DENIED`.
Each remote Provider is created for one `WorkspaceRef` and always sends its id.
A test proves a call for another workspace is refused.

**Transport security:** the WebSocket transport accepts only `wss://` (or
`ws://localhost` for development), checks the certificate, and refuses before
sending the token. A test covers the refusal.

**Changes:** `cli` gets `tnega daemon --server URL --token T --workspace PATH`;
`runtime/compose.ts` takes a `machine` option: `local` (today) or
`{ connection, workspace }` (remote Providers bound to that workspace).

**Done when:** the loopback contract test runs the existing tool test suites
against `fs-remote` + `process-remote` over the in-process transport, and a
recorded session replayed through it equals the local run.

**As built (2026-11-04):** `protocol`, `daemon`, `fs-remote` and
`process-remote` are in. The WebSocket client uses undici's `WebSocket`
(Node 22's global one cannot send an `Authorization` header). The runtime takes
`machine: { link }`: files, commands and search go to the daemon, and spill,
office and skills stay off in that mode because they still read this machine's
disk. The runtime sends the sandbox mode with each command and the daemon
enforces it (read-only when none is sent); the daemon always fences paths, so
`bypass` does not reach outside the workspace remotely. Background processes
report their output with `process/tail` (every 500 ms) instead of
`process/write`. A mutating call carries a `callId` and the daemon answers a
retry from memory (last 512). Checks: the `tool-fs` suites and the runtime
`builtins` shell suite run unchanged through a loopback daemon
(`packages/daemon/daemon/test/contract-*.test.ts`), and
`packages/runtime/test/machine-parity.test.ts` runs the same tool calls locally
and through the daemon and compares the model-visible text. **Not yet:**
`terminal/*`, `browser-remote`, `computer-remote` and `process/write`; local mode
still calls the local Providers directly rather than through an in-process
daemon. The server side that accepts daemons over WebSocket arrives with M3
(device tokens), so `tnega daemon` has nothing to dial until then except a test
or a hand-built runtime.

**Hand-off prompt:**

```text
Build phase P4 of docs/plans/v2-package-changes.md in the tnega repo: the
daemon protocol. P1 (ctx.fs) and P2 (ctx.process) are merged.
1. Read docs/plans/v2-plan.md (Decided table), v2-server-mvp.md section 4.3,
   packages/fs/fs, packages/process/process, packages/terminal,
   packages/browser/browser, packages/computer/computer.
2. Add packages/daemon/protocol (JSON-RPC 2.0 types, version, method table),
   packages/daemon/daemon (serves methods from local Providers; in-process and
   WebSocket transports), packages/daemon/{fs,process,browser,computer}-remote. Every call carries a
   workspaceId the daemon announced; remote URLs must be wss:// with a checked
   certificate.
3. Add `tnega daemon` to packages/cli. compose.ts chooses local or remote
   Providers from an option; nothing else in runtime knows which.
4. Contract test: run the fs and shell tool tests against the remote Providers
   over the in-process transport. Tests for cancel, heartbeat loss, reconnect
   and version refusal (N and N-1 accepted).
5. Run typecheck, lint, test. Open PRs per package group. No CHANGELOG edits.
```

## P5 Host split

**Why:** `packages/host/src/server.ts` mounts machine-side routes itself:
`fileRoutes` (workspace-files), `TerminalManager` and `terminalRoutes`,
`PlaywrightBrowserHost` and `browserRoutes`, `folderPickerRoutes`,
`sandboxSetupRoutes`, `computerSetupRoutes`.

**New `packages/daemon/daemon-routes`**: one plugin that registers those routes
from the daemon's side. In local mode `startWebServer` mounts it from the
in-process daemon. On a server, files, terminal and browser are served by the
server's own routes calling the daemon's `fs/*`, `terminal/*` and `browser/*`
methods for the session's workspace (no HTTP proxying). Folder picker, sandbox
setup and computer setup stay **local only** in v2.0: they configure the
machine you sit at, and the server answers them with 404.

**Changes:** `host/server.ts` drops the direct imports of `@tnega/terminal`,
`@tnega/browser-playwright`, `@tnega/directory-picker`, `@tnega/sandbox-local`
and `@tnega/computer-cua`; `host/context.ts` loses `terminals` and the
browser host; `apps/desktop/src/main.ts` starts the in-process daemon next to
`startWebServer`.

**Done when:** `packages/host` imports no machine-side package, every web and
desktop route test passes unchanged, and the desktop app runs as before.

**As built (2026-11-04):** `packages/daemon/daemon-routes` mounts `fsLocal`
with the file routes, the terminal routes with their own `TerminalManager`,
the browser view, the folder picker and the sandbox and computer-use setup
routes; `startWebServer` mounts that one plugin, so `host/server.ts` no longer
imports `@tnega/terminal`, `@tnega/directory-picker`, `@tnega/sandbox-local`,
`@tnega/computer-cua` or `@tnega/fs-local`, and `ServerContext` loses
`terminals`. URLs and responses are unchanged. Two things stay in the host
until `browser-remote` exists: the `PlaywrightBrowserHost` (the agent's
`browser_*` tools drive the same page the Workbench shows, so the host creates
it and passes it to the routes), and `@tnega/workspace-files` for the file-edit
baselines in `runs.ts`. The desktop app needs no change: it already starts the
host in process, which mounts the routes.

**Hand-off prompt:**

```text
Build phase P5 of docs/plans/v2-package-changes.md: move machine-side routes
out of packages/host into a daemon-routes plugin. P4 is merged.
Read packages/host/src/server.ts, context.ts, routes.ts, apps/desktop/src/main.ts
and apps/desktop/AGENTS.md first. Move file, terminal, browser, folder picker,
sandbox setup and computer setup routes into packages/daemon/daemon-routes,
mounted from the in-process daemon in local mode. URLs and responses must not
change; the web tests and desktop smoke test are the check. No CHANGELOG edits.
```

### P4 follow-up: forwarded Services (2026-11-04)

Agreed with the owner: terminal, browser and computer use reach a daemon
through two shared pieces instead of one protocol method each. `service/call`
forwards any method of a Service the daemon lists in `capabilities.services`,
and `stream/open` / `stream/event` / `stream/resume` / `stream/close` carry a
listener method as a numbered stream that a new connection can resume (512
events kept, 30 s grace, then the daemon unsubscribes). Errors keep a numeric
`status`. The terminal is first: `packages/terminal/{terminal,terminal-local,
terminal-routes}` is the seam, `daemon/terminal-remote` the remote Provider,
and the daemon serves only folders inside its announced workspaces. Next:
browser (separate profile by default, frames only while watched) and computer
use (off unless the device opts in, local stop key).

### Cross-OS daemon paths (2026-11-08)

A daemon may run another OS than the runtime (a Windows PC serving a Linux
server). Paths stay in the daemon's form end to end: `@tnega/fs` has
`workspacePath(root)`, which picks `path.win32` or `path.posix` from how the
root is written, and the file tools and `glob` / `grep` show paths with it.
`shell` resolves its `cwd` through the workspace's `ctx.fs` handle (the same
fence as the file tools, on the machine that holds the files), `glob` / `grep`
fence their root the same way, and `announcedWorkspace` compares roots by the
daemon's rules (case-insensitive on Windows).

### Browser on a daemon (2026-11-08)

`tnega daemon --browser` serves a browser on that machine: its own profile,
started on first use, never the person's browser. The daemon's `browser`
Service forwards `run` (one `BrowserAction`, shape-checked on the daemon),
`snapshot`, `screenshot`, `evaluate`, `console`, `network` and a `watch`
stream with page, tab and log changes (no frames yet).
`daemon/browser-remote` is the Provider of `ctx.browser`: it keeps page, tabs
and logs from `watch` so the synchronous reads stay local, and turns a
`BrowserError` from the daemon back into one with the same code.
`browser/pre-action` runs in the runtime before anything is sent, so policy
and approvals stay where they were. `packages/runtime` mounts it with
`tool-browser` for a scope on a daemon that lists `browser`; `browser: false`
turns it off. A scope on this machine still gets its browser from its host.

## P6 Client profiles

**Changes:**

| Package | To |
|---|---|
| `client` (`api.ts`, `types.ts`) | `ServerProfile { id, label, url, token? }`; every request sends `X-Tnega-Protocol`; the server answers its version on `/api/info`; types become a versioned schema |
| `apps/web` | Settings: Connection (This computer / a server URL with pairing code); follows the design guide |
| `apps/desktop` | stores profiles; This computer starts the local server as today |
| `tui` | `tnega tui --server URL` |

**Hand-off prompt:**

```text
Build phase P6 of docs/plans/v2-package-changes.md: connection profiles.
Read docs/design/tnega-design.md (sections listed in its §0 table for Settings),
packages/client/src/api.ts and types.ts, the Settings pages in apps/web/src.
Add ServerProfile and a protocol header to @tnega/client, a Connection setting
in web and desktop (This computer stays the default), and --server for the TUI.
Add a test for what happens after a profile is chosen. Go through the design
guide's §11 checklist before you open the PR. No CHANGELOG edits.
```

## P7 Server (server release line)

New packages under `packages/server/` as listed in the layout, built to the
schema and loops in [v2-server-mvp.md](v2-server-mvp.md). `server/server`
composes `createAgentRuntime` with `session-store-pg`, `blackboard-pg`,
`jobs-pg`, `blobs-local` and the remote fs/process Providers bound to each
session's daemon. Tests run on PGlite in the code layer and on real Postgres in
`*.e2e.test.ts`. Adds `.github/workflows/server-release.yml` on `server-v*` tags
and `deploy/compose.yaml`.

**Hand-off prompt:**

```text
Build phase P7 of docs/plans/v2-package-changes.md: the tnega server MVP.
P3 and P4 are merged. Follow docs/plans/v2-server-mvp.md exactly for scope,
schema (packages/server/db with migrations), append semantics, effects queue,
daemon registry and auth. Build in the order of its section 7, one PR per step.
Code-layer tests use PGlite; real Postgres tests are *.e2e.test.ts. Every outside
action goes through the effects queue and must be safe to repeat. Do not change
local mode. No CHANGELOG edits.
```

## P8 Machines

New `packages/machine/machine` (Definition `ctx.machines`, `MachineProvider`
with `start(key, spec)`, `pause`, `stop`, `status`), `machine-e2b` (E2B runtime
API: Firecracker microVMs from a template, pause with memory, resume; stores the
machine id in sandbox metadata) and `egress-proxy` (built on
`sandbox-network-proxy`, which today only tunnels HTTPS with CONNECT; for hosts
that get a key the egress proxy terminates TLS with a per-deployment CA trusted
only by the box template, validates the upstream certificate, injects the key
over TLS only and drops it on cross-host redirect; other hosts stay plain
tunnels). The box template is `deploy/e2b/template/`. No
Docker box Provider ([ADR 0018](../adr/0018-microvm-box-layer.md)).

**Hand-off prompt:**

```text
Build phase P8 of docs/plans/v2-package-changes.md: microVM boxes on E2B's
open-source runtime (e2b-dev/runtime). P7 is merged. Read v2-server-mvp.md
sections 4.2, 4.4 and 4.7, docs/adr/0018, packages/sandbox/sandbox-network-proxy
and docs/adr/0008. Add packages/machine/machine, machine-e2b and egress-proxy,
and deploy/e2b/template with tnega daemon. start(key, spec) must return the
same box on a repeat (resume a paused one). The setup step gets only approved
secrets; the box's egress rule allows only the proxy. Host-layer tests need a
KVM host with the runtime and are named *.e2e.test.ts. No CHANGELOG edits.
```

## Sizes and splits

Every package above has one role. `daemon/daemon` serves several method groups
but only forwards to existing Providers, so it stays one package unless it
grows past about 1,500 lines, in which case the terminal, browser and computer
handlers move into their own `daemon-*` packages.

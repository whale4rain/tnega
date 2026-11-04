# Tnega v2 plan

> 状态：进行中（提案，2026-11-03，基线 0.5.6）
> 取代关系：无
> 当前实现：尚未实现；现状见 `packages/session/README.md`、`packages/execution/README.md`、`docs/adr/0006-capability-seams.md`、`docs/adr/0008-sandbox-seam.md`

## Goal

v1 built a full agent that runs on one computer. v2 lets the same agent run on
the user's computer, on a server they own, or on a cloud box, with the same
Session history, tools and safety rules. Three things get pulled apart:

- **Compute**: where tools run (shell, files, search, browser).
- **State**: where the truth lives (Session logs, Blackboard, attachments, artifacts).
- **Environment**: what the box contains (image, setup script, env vars, secrets, network policy).

Most of this is new Providers on the existing seam pattern, plus a thin server.

## What carries over and what ties tnega to one machine

Carries over: the append-only Session log with model history rebuilt from
durable events and crash resume (`findInterruptedTurn`); the plugin kernel;
Definition / Provider / Consumer seams; clients that already speak HTTP + SSE
through `@tnega/client`; the filtering network proxy and fail-closed sandbox.

Ties tnega to one machine today:

| Area | Today | Needed |
|---|---|---|
| Host | `127.0.0.1`, no accounts (`packages/host/src/server.ts`) | identity, device tokens, members |
| Session storage | `~/.tnega/sessions/<sha256(path)>`, pid + hostname lock (`packages/home/src/home-paths.ts`, `packages/session/src/lock.ts`) | `WorkspaceRef` instead of path; append with expected seq |
| Execution | library passed as config; file tools call `node:fs` | `ctx.execution` and `ctx.workspace` seams |
| Blackboard | one journal, one writer, no compaction | database Provider |
| Jobs, routines | jobs lost on restart; routines need the project open | durable job records; scheduler |
| Attachments | base64 inside Session events | content-addressed blob store |
| Credentials | keys readable by the process that runs tools | keys in the control plane; egress proxy adds them |

## Models

- **Codex cloud**: container per task from a `universal` image; setup script with
  internet, agent phase with internet off by default; secrets only during setup;
  container cache up to 12 hours, reset when the setup changes.
- **Claude Code on the web**: isolated VM per session; network policy per
  environment; a proxy adds credentials so the agent never holds keys; sessions
  move between web and terminal.
- **OpenHands SDK**: one Workspace interface, local and remote implementations;
  remote is an agent server in Docker with command and file APIs; tools run where
  the workspace is.
- **Devin, Cursor background agents**: long-lived VMs started from snapshots.
- **E2B, Daytona, Modal**: sandbox services; candidates for later box Providers.

## Design

Revised 2026-11-04 with the owner. The diagram is the project report
`reports/v2-plan/tnega-v2-architecture.html`; the state and control MVP is
[v2-server-mvp.md](v2-server-mvp.md).

### Decided

| Topic | Decision |
|---|---|
| Shape | **tnega server** (headless runtime + state + control) and **daemons** (files, commands, environment). The agent loop runs in the server; a model call takes seconds, so one network hop per tool call is cheap, and a laptop or edge device only runs a thin daemon. |
| Daemons | Local (your machine as it is, sandbox bwrap / seatbelt / MXC, browser, computer use), Docker box (built from `.tnega/environment.toml`, started by the server), edge (fixed device). A daemon keeps no history. |
| Seams | Two new low-level seams like DSH's `ctx.fs` / `ctx.subprocess`: **`ctx.fs`** (new) and **`ctx.process`** (promotes `ExecutionProvider`). Local Provider = today's code; remote Provider = the daemon. Search, jobs, sandbox and secrets decorators sit on top; browser and computer get a remote Provider. Rejected: a remote twin of every existing Provider (about six protocols, and `read_file` / `shell` have no seam to extend). |
| Daemon protocol | JSON-RPC 2.0 over one WebSocket that the daemon opens. Method namespaces mirror the seams (`fs/*`, `process/*`, `terminal/*`, `browser/*`, `computer/*`). Plain JSON only: cancel by request id, output as notifications. Handshake: protocol version, device id, capabilities. Server accepts versions N and N-1. |
| Client protocol | Keep HTTP + SSE; add a protocol version and typed schema to `@tnega/client`. Revisit JSON-RPC for clients at M3 only if server push needs it. |
| Repos and releases | One repo, two release lines: harness (`v*` tags: npm `tnega`, desktop, CLI/TUI, `tnega daemon`) and server (`server-v*` tags: `tnega-server` and `tnega-daemon` images, `deploy/` compose then Helm). Operations for a hosted service may live in a private repo later. |
| Versions | Stay on 0.x previews until the 1.0 gate passes. |
| Local mode | Desktop, CLI and TUI start server and daemon in one process with an in-process transport and the JSONL / file Providers. Works offline. |

### How it is built today and what changes

Today `startWebServer` (`packages/host`) is one process: HTTP + SSE API, the
web app, a runtime per session (`createAgentRuntime`, with
`localExecutionProvider` hard-wired in `packages/runtime/src/compose.ts`), and
host routes that touch the machine directly (Workbench file routes,
`TerminalManager`, the Playwright browser host, the folder picker, the process
list). Steps, each a normal 0.x PR with no user-visible change:

1. `ctx.fs` seam: Definition + `fs-local` Provider; `tool-fs` and the
   Workbench file routes move onto it.
2. `ctx.process` seam: promote `ExecutionProvider`; sandbox and secrets become
   decorators of `ctx.process`; shell, ripgrep, jobs and terminals use it;
   `compose.ts` picks the Provider.
3. Contract test: a JSON-RPC loopback runs the tool tests through
   serialize/deserialize.
4. Host / daemon split: `tnega daemon` owns fs, process, terminal, browser and
   the folder picker; the host keeps routes, runtime and state; local mode
   starts both in one process.
5. Clients: connection profiles in `@tnega/client` (This computer / server URL
   + token). Session keys become daemon + path (`WorkspaceRef`).

Deployment: **local** (default, offline, unchanged), **self-hosted** via
`docker compose` (the v2.0 target), **hosted** (later, not blocked).

## Rules to settle before building

- **What the control plane stores.** It never opens the workspace, but the
  Session log holds tool results, and tool results quote file contents. So the
  control plane does store workspace excerpts (in the log, spills and uploads).
  The MVP rules (owner-only access, deletion with the session, encrypted disks)
  are in [v2-server-mvp.md §3.4](v2-server-mvp.md#34-what-the-server-stores-about-a-workspace);
  retention periods and project-member access are settled there before
  `ctx.sessionStore` is frozen.
- **Credentials on the wire.** The egress proxy (not the daemon, not git)
  holds model keys and the scoped git token. It attaches them only to
  allowlisted hosts, only over TLS with a validated certificate, never to
  plain HTTP, and drops them when a redirect leaves the host. Today's
  `sandbox-network-proxy` filters hosts but injects no keys; this is new work.
- **Setup script trust.** The setup script is repository content, so whoever
  can change the repo can change it. Secrets reach it only after the user
  approves the environment, and approval is asked again whenever the setup
  script or the secret list changes (by hash). Only the secrets the spec names
  are exposed, for the setup phase only. Setup egress is filtered too: an
  allowlist of package registries by default, wider only by the user's choice.
- **Runner append and replay.** Each durable event carries an id; the control
  plane deduplicates retries by id, and an append answers `committed` (with
  its seq) or `conflict` (with the current seq). A runtime or daemon that loses its
  connection and cannot tell whether an append landed reads the log back from
  its last committed seq before sending anything else. M1 ships tests for
  retry, duplicate, gap and reconnect.

Unchanged invariants: Session log is the only source of model history;
`renderToolResult` is the only tool-result text; the sandbox fails closed; new
behaviour arrives as plugins.

## Road to 1.0

1.0 freezes the contracts v2 speaks: Session format, Blackboard journal, plugin
and seam APIs, wire types. Young features ship in 1.0 marked Preview.

Gate:

- **Contracts**: versioned formats with migration tests from every release;
  documented plugin and seam APIs; versioned `@tnega/client` wire types.
- **Reliability**: kill-and-restart tests for runs, jobs, project threads; the
  open project message items closed; two release gates in a row pass on
  Windows, macOS, Linux.
- **Agent quality**: Terminal-Bench on each beta; goal at least double the
  2026-10-24 score (9.1% plain, 12.1% with retries).
- **Sandbox**: Windows piped children solved, or the dedicated sandbox user
  designed and proven as `docs/roadmap.md` asks: a design note (account
  lifecycle, credential storage, grant set, uninstall) and a clean Windows VM
  spike running `npm run dev` with piped children.
- **Chat**: images and files in agent replies; simple A2UI.
- **Docs**: user guide, plugin author guide, upgrade notes.

Groundwork shipped in the 0.x previews, each with a local Provider only:
`ctx.execution` / `ctx.workspace`; `ctx.sessionStore` with seq-checked append;
blob store (old inline images still readable); `WorkspaceRef`; durable jobs and
a desktop scheduler for routines; the environment spec run locally in a worktree.

## v2 milestones

1. **M1 Daemon protocol**: steps 1–4 above plus `tnega daemon`; handshake,
   capabilities, cancel, heartbeat; idempotent calls and reconnect as above;
   local mode uses it in-process; a session run through the loopback equals one
   run locally.
2. **M2 Container box**: Docker Machine Provider (a "box"; `ctx.box` is already the Project message channel), environment setup phase, egress
   proxy that holds the keys and the scoped git token (TLS only, allowlisted
   hosts, dropped on cross-host redirect), compose file.
3. **M3 Server state and sign-in**: Postgres store, blob store, device tokens
   (see [v2-server-mvp.md](v2-server-mvp.md));
   connection profiles in web, desktop, TUI.
4. **M4 Projects on the server**: a Docker box per thread, sleep and wake, routines
   without a window, branch per thread with a pull request card.
5. **M5 Hand-off and hardening** (2.x): laptop/server hand-off, snapshots,
   budgets, audit, Postgres, microVM Provider, several people in one project.

v2.0 = M1 to M4.

## Risks

Size for a small team (each milestone ships alone; local mode untouched);
Docker boxes are Linux, so Windows-only features stay local; existing sessions need a
one-time import that keeps the old files; a server that runs code is a larger
target, so review auth before M3.

## Open decisions (owner)

- Version numbers: decided 2026-11-03, stay on 0.x previews (0.6, 0.7 …) and jump to `1.0.0` when the gate passes.
- v2.0 target: self-hosted first.
- First box: Docker or Podman; microVM later.
- Database: Postgres for the server from the start (changed 2026-11-04, see
  [v2-server-mvp.md](v2-server-mvp.md)); local mode keeps JSONL and files.

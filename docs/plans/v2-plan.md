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

**Control plane** (thin; never runs tools and never opens the workspace): accounts
and device tokens, session store, Blackboard and blob stores, run router (start,
stop, sleep, wake), scheduler, secrets vault, environment specs and snapshots.

**Runners**, one per session or project thread, each in a box chosen by a Box
Provider: local process (default, today's behaviour), container (v2.0), microVM
or sandbox service (later). The whole tnega runtime (`createAgentRuntime`) runs
inside the runner, next to the files. The runner streams durable events to the
control plane, which is the only writer of the log. Model and git traffic leaves
through the **egress proxy**, which applies the network policy and adds keys.

Seams:

- **Compute**: promote `@tnega/execution` to `ctx.execution`; add `ctx.workspace`
  for file operations; move `tool-fs`, `tool-search`, `tool-shell` onto them. The
  existing sandbox stays on inside a box.
- **State**: `ctx.sessionStore` with a JSONL Provider (today) and a remote
  Provider (control plane; SQLite on one server, Postgres later). Appends carry
  the expected sequence number. Blob store for images, spills, uploads,
  artifacts. Blackboard database Provider. `WorkspaceRef` = local path, git repo
  + branch, or volume.
- **Environment**: `.tnega/environment.toml` with base image, setup and
  maintenance scripts, env vars, secret names, network policy (`sandbox.network`
  vocabulary), resources, idle timeout. Setup has internet and secrets; the agent
  phase has the policy and no secrets. Snapshots keyed by spec hash and commit.

Also: durable job records; routines with no window open; threads that sleep and
wake; hand-off of a session between laptop and server; the agent browser shown
through the existing screencast; computer use stays local in v2.0.

Deployment: **local** (default, offline, unchanged), **self-hosted** via
`docker compose` (the v2.0 target), **hosted** (later, not blocked).

## Rules to settle before building

- **What the control plane stores.** It never opens the workspace, but the
  Session log holds tool results, and tool results quote file contents. So the
  control plane does store workspace excerpts (in the log, spills and uploads).
  Before `ctx.sessionStore` is frozen, define who can read a session (owner and
  project members only), how long logs and blobs are kept, deletion with the
  session, and encryption at rest for the server store.
- **Credentials on the wire.** The egress proxy (not the runner, not git)
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
  its seq) or `conflict` (with the current seq). A runner that loses its
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

1. **M1 Runner protocol**: `tnega runner`; start, stream, append, cancel,
   heartbeat; idempotent append and reconnect as above; local host uses it
   in-process; replay from a runner equals local.
2. **M2 Container box**: Docker Box Provider, environment setup phase, egress
   proxy that holds the keys and the scoped git token (TLS only, allowlisted
   hosts, dropped on cross-host redirect), compose file.
3. **M3 Remote state and sign-in**: SQLite store, blob store, device tokens;
   connection profiles in web, desktop, TUI.
4. **M4 Projects on the server**: a runner per thread, sleep and wake, routines
   without a window, branch per thread with a pull request card.
5. **M5 Hand-off and hardening** (2.x): laptop/server hand-off, snapshots,
   budgets, audit, Postgres, microVM Provider, several people in one project.

v2.0 = M1 to M4.

## Risks

Size for a small team (each milestone ships alone; local mode untouched);
runners are Linux, so Windows-only features stay local; existing sessions need a
one-time import that keeps the old files; a server that runs code is a larger
target, so review auth before M3.

## Open decisions (owner)

- Version numbers: decided 2026-11-03, stay on 0.x previews (0.6, 0.7 …) and jump to `1.0.0` when the gate passes.
- v2.0 target: self-hosted first.
- First box: Docker or Podman; microVM later.
- Database: SQLite first, Postgres later.

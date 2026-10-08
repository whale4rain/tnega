# Projects: token cost, interaction flow, UX (working notes)

Date: 2026-10-08. Status: analysis only, no code changed yet. Continues
`2026-10-08-dense-redesign-handoff.md` (phase 3 and follow-ups are still open).

## Baseline

- `pnpm test`: 1473 pass, 2 fail on Linux (pre-existing, platform-specific):
  `fs-sandbox/test/containment.test.ts` (case-insensitive compare) and
  `sandbox-windows-acl/test/workspace-sid.test.ts`.
- Real model: DeepSeek via the OpenAI-compatible adapter
  (`packages/llm/src/models.ts`, default `deepseek-v4-flash`), key in
  `DEEPSEEK_API_KEY`.

## 1. Token cost and multi-agent collaboration

Findings from `packages/cli/src/project-host.ts`, `thread-local`, `project-loop`,
`tool-thread`:

- **Every Agent sees every tool.** One `ToolsService` per project; coordinator
  and threads all receive shell/edit/office/jobs/routine/approval schemas on
  every request. Seam for scoping: `AgentCreationOptions.setup(agentCtx)` →
  `agentCtx.on('agent/request', …)` filters `request.tools` per Agent (same
  pattern as `tool-ptc`). Add a matching `tools.guard` keyed on
  `options.agentId` so hidden tools also can't be called.
  - Coordinator: coordination + read/search tools; no write/shell/jobs.
  - Threads: no routine tools; no `spawn_thread` at `maxDepth`.
- **Thread prompt over-delegates.** `THREAD_SYSTEM_PROMPT` tells threads to
  dispatch sub-threads "at the start of substantial work"; each sub-thread
  repeats system prompt + tools + `read_project`. Default should be: keep work
  in the thread; spawn only for large, clearly independent branches.
- **Reports injected into the coordinator are unbounded.** Quiet `complete`
  envelopes go in full via `inject`. Cap to the outcome (~600 chars) plus a
  pointer to the thread; the full text stays in the thread.
- **Prompt-cache stability (DeepSeek prefix cache).** Check that system
  prompt sections and tool order are stable across requests (skills index,
  workspace prompt), so the cached prefix is reused.
- `read_project` output size: check and bound.

## 2. Interaction flow

To verify against the real model: user → room → coordinator dispatch → thread
checklist → report → Board "Ready" → resolve. Watch for coordinator
recapping results in the room, threads ending with questions instead of
`request`, and duplicate thread spawns for one subject.

## 3. UX

Phase 3 of the dense redesign (thread card one line, compact Board, thread view
checklist-first) and the sidebar status dots follow-up, which needs an additive
state field on `GET /api/sessions` / `GET /api/projects`.

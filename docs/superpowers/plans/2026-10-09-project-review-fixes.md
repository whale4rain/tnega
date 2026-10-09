# Project review fixes

**Goal:** Fix all twelve confirmed Spec and Standards findings from the Project review.

**Architecture:** Keep the existing capability seams. Coordinator tools are an explicit coordination surface; Thread owns execution. Blackboard recovers only complete transactions. Project UI derives fresh state after reconnect and opens artifacts in Workbench.

**Spec:** `docs/project/projects-design.md`, `docs/design/tnega-design.md`, `CONTEXT.md`, and the review in this chat.

**Constraints:** Preserve existing data, read legacy journals, keep strict TypeScript, add behavioral regression tests for concurrency/recovery, commit independent fixes with Unreleased notes. Existing checkout is clean; work on `codex/project-review-fixes`. No external publishing.

## Work and ownership

- [ ] Blackboard recovery: `packages/project/blackboard-local/` and adjacent tests/README. Repair torn tails before append; store complete atomic batches, retain legacy single-record reads. Test truncation at every relevant boundary and reopen after a recovered commit. Document forward/rollback compatibility.
- [ ] Project Loop: `packages/loop/project-loop/`. Propagate genuine Agent failures as failed Thread reports without treating user cancellation as failure; suppress coordinator narration only for successful, fully settled requests. Test provider errors and failed coordination calls.
- [ ] Host lifecycle: `packages/cli/src/project-host.ts`, CLI tests. Cache the entire mounting promise before any await; release partial scopes on failure. Dispose SSE Session listeners. Test concurrent first mounts and unsubscribe behavior.
- [ ] Coordinator tools: `project-tool-scope.ts`, `thread-local` prompts/tests/README. Permit coordination and shared-state tools explicitly, deny investigation and deliverable tools including PTC nested calls. Test model surface and execution guard.
- [ ] Pause: host/routines and Project UI. Persist paused project state; stop dispatch and routine scheduling until explicit resume; keep queued work intact. Test pause across reload and resumed scheduling.
- [ ] Reconnect: host watch and Web stream model/API. On connection establish synchronize a fresh snapshot with live statuses; ensure no snapshot/subscription gap. Test missed fact changes and stale running flags.
- [ ] Artifact Workbench/source navigation and Memory: Web project/workbench components. Open artifact previews as reusable document tabs, link Library to source Thread/message, retain the version captured when editing memory. Update web-contract and test observable navigation/conflict behavior.
- [ ] Integration: review all diffs; run scoped tests, typecheck, lint and build. Verify all twelve findings are addressed and no unrelated files are committed.

## Coordination

Independent Blackboard, Loop, and Web domains may run in parallel with exclusive file ownership. Root owns CLI host, shared docs, CHANGELOG and all commits to avoid Git/index and changelog conflicts. Root reviews each completed domain before committing. Shared Web stream changes are integrated after the artifact task.

## Verification commands

Use `pnpm test -- <files>`; this host's pnpm launcher currently fails before execution, so use `node node_modules/vitest/vitest.mjs run <files>` when needed. Sandbox temporary-cache rename may require the same command with approved elevated execution. Use package scripts for final checks, or their exact Node entrypoints if the launcher remains unavailable.

# Project review fixes

**Goal:** Fix all twelve confirmed Spec and Standards findings from the Project review.

**Architecture:** Keep the existing capability seams. Coordinator tools are an explicit coordination surface; Thread owns execution. Blackboard recovers only complete transactions. Project UI derives fresh state after reconnect and opens artifacts in Workbench.

**Spec:** `docs/project/projects-design.md`, `docs/design/tnega-design.md`, `CONTEXT.md`, and the review in this chat.

**Constraints:** Preserve existing data, read legacy journals, keep strict TypeScript, add behavioral regression tests for concurrency/recovery, commit independent fixes with Unreleased notes. Existing checkout is clean; work on `codex/project-review-fixes`. No external publishing.

## Work and ownership

- [x] Blackboard recovery: `packages/project/blackboard-local/` and adjacent tests/README. Repair torn tails before append; store complete atomic batches, retain legacy single-record reads. Test truncation at every relevant boundary and reopen after a recovered commit. Document forward/rollback compatibility.
- [x] Project Loop: `packages/loop/project-loop/`. Propagate genuine Agent failures as failed Thread reports without treating user cancellation as failure; suppress coordinator narration only for successful, fully settled requests. Test provider errors and failed coordination calls.
- [x] Host lifecycle: `packages/cli/src/project-host.ts`, CLI tests. Cache the entire mounting promise before any await; release partial scopes on failure. Dispose SSE Session listeners. Test concurrent first mounts and unsubscribe behavior.
- [x] Coordinator tools: `project-tool-scope.ts`, `thread-local` prompts/tests/README. Permit coordination and shared-state tools explicitly, deny investigation and deliverable tools including PTC nested calls. Test model surface and execution guard.
- [x] Pause: host/routines and Project UI. Persist paused project state; stop dispatch and routine scheduling until explicit resume; keep queued work intact. Test pause across reload and resumed scheduling.
- [x] Reconnect: host watch and Web stream model/API. On connection establish synchronize a fresh snapshot with live statuses; ensure no snapshot/subscription gap. Test missed fact changes and stale running flags.
- [x] Artifact Workbench/source navigation and Memory: Web project/workbench components. Open artifact previews as reusable document tabs, link Library to source Thread/message, retain the version captured when editing memory. Update web-contract and test observable navigation/conflict behavior.
- [x] Integration: review all diffs; run scoped tests, typecheck, lint and build. Verify all twelve findings are addressed and no unrelated files are committed.

## Coordination

Independent Blackboard, Loop, and Web domains may run in parallel with exclusive file ownership. Root owns CLI host, shared docs, CHANGELOG and all commits to avoid Git/index and changelog conflicts. Root reviews each completed domain before committing. Shared Web stream changes are integrated after the artifact task.

## Verification commands

Use the pnpm package scripts with approved elevated execution on this host; sandboxed launcher/cache operations failed before running checks. Direct tsc invocation did not reproduce the configured pnpm environment.

## Acceptance evidence

- All five Spec and seven Standards findings are addressed. Existing explicitly proposed settings/upload APIs remain outside this review's implementation scope.
- `pnpm test -- packages/project packages/loop/project-loop packages/cli/test/project packages/cli/test/thread-approval.test.ts test/project-tools.test.ts apps/web`: 60 files, 333 tests passed.
- Final reconnect reply-link regression: `pnpm test -- apps/web/src/lib/project-model.test.ts`: 24 tests passed.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed. The final model adjustment also passed typecheck and scoped ESLint; Web was rebuilt afterward.
- Additional check limitation: `pnpm --dir apps/web build` fails in transitive backend types under the Web subpackage's ES2022/Bundler configuration (ES2023 array methods, Headers and PptxGenJS). This is distinct from the successful required root build/typecheck. The final Web output uses the root build's Vite step; no TypeScript suppression was added.
- Browser acceptance (`node apps/web/e2e/project-artifacts.mjs`) passed light/dark Sky and light/dark Sand with Large/Comfortable settings, covering source navigation, Workbench snapshot previews/tab reuse, and Memory conflict draft retention. Sixteen screenshots were generated; eight were visually inspected without clipping or overlap.
- Broader regression exposed an approval/state write race; per-Thread serialization fixes it. Crash recovery coverage now targets structural transaction boundaries and UTF-8 byte boundaries rather than redundant fsync work on every ASCII byte.
- Implementation commits: `f26de12`, `235d260`, `9a364a7`, `3ddf4e3`, `1c30d32`, `32e3d23`, `8b13ba1`, `d6a4fc3`.
- Compatibility: legacy Blackboard journals remain readable. Once the new transaction format is written, direct downgrade or mixed-version writers are unsupported.

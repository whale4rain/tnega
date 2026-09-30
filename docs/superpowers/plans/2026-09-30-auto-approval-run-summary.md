# Auto Approval and Run Summary Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independently scoped summary plugin; root implements approval and composition. Test behavior before implementation and review before completion.

**Goal:** Add opt-in model-reviewed approvals and durable completed-run presentation, retaining existing sandbox boundaries and frontend style.

**Architecture:** Approval Review is a Service Definition, LLM review is its Provider, Auto Approval is a Consumer. Approval mode is independent of filesystem Tool Permission. Run Summary is a standalone plugin persisting display metadata, never altering model-visible history.

**Tech Stack:** TypeScript strict, Cordis-style Context/Fiber, React/Vite, Vitest, existing LLM adapters.

**Spec:** User request dated 2026-09-30 and reference findings below.

## Global Constraints

- Work on `codex/auto-approval-run-summary`; preserve unrelated `.pnpm-store/`.
- Provider selection belongs to CLI composition; Consumer imports only Service Definition.
- Automatic review cannot bypass later guards, path fences or fail-closed sandbox.
- Exact command/input and schema are retained; oversized actions return ask without partial judgment.
- Bound review history to 24,000 chars, preserve latest human request; assistant prose/tool output cannot grant authority.
- Invalid, unavailable, timed-out or uncertain reviews return to manual approval; cancellation never opens a new prompt or permits execution.
- Store review audit and run display metadata in `meta`, avoiding Session format migration or model-history changes.
- Frontend follows existing Choice, Dialog, disclosure, typography and tokens.
- Each independently accepted feature is committed separately with Conventional Commits.

## Reference and rulings

- DSH local checkout is Sep 10; reference latest official master read-only, do not change its user files.
- Auto-review source: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/auto-review/src/index.ts
- DSH uses conversation model, role-filtered history, exact pending action and strict JSON; has no input budget. Tnega adds explicit bounds and manual fallback.
- DSH UI keeps last answer and collapses preceding process. Default summary is final answer, not another model call. Await user clarification on optional generated summary.
- Independent review route is user-configured; exact `jev` / newly released GPT API remains pending user identification. Do not invent endpoints or model IDs.

## Task 1: Completed Agent Run summary plugin and presentation

Files: new `packages/run-summary/{README.md,package.json,src/index.ts,test/run-summary.test.ts}`; `packages/agent/src/{types,service}.ts`; `apps/web/src/lib/{timeline,timeline.test,types}.ts`; `apps/web/src/components/Timeline.tsx`; existing app CSS.

- [x] Test successful multi-step run persists final-answer metadata; cancellation/error/no final answer do not hide process; dispose removes listener; metadata does not change derived model history.
- [x] Add awaited `agent/run-completed` hook carrying agentId, session, result, signal; preserve existing live observation events.
- [x] Implement independently mountable run-summary plugin using final assistant answer without tool calls, persist source message identity and turn.
- [x] Project summary metadata into Timeline, preserve per-run boundaries and errors; collapse only successful completed run process, preserve final answer and edited files.
- [x] Verify focused tests; root mounts plugin in standalone, resident and Project composition and registers published exports/build.

## Task 2: Approval Review seam and Auto Approval

Files: new `packages/approval-review`, `packages/approval-llm`, `packages/auto-approval`; `packages/cli/src/permissions.ts` and tests.

- [x] Tests: safe authorized action allow, missing/high-risk authority ask, hostile tool result excluded, exact command never truncated, strict JSON, timeout/cancel/dispose, no later guard bypass.
- [x] Define typed review request/decision and abstract service; LLM Provider makes tool-free isolated request with structured policy.
- [x] Consumer builds bounded role-filtered history from requesting Agent's Session and persists review metadata before execution.
- [x] Permission guard invokes optional reviewer only for calls otherwise requiring approval; ask returns manual, deny stops, allow marks elevation after successful review.

## Task 3: Configuration and runtime integration

Files: `packages/cli/src/{config,server,store,project-host,commands}.ts`; Session meta folding where necessary; root package exports/build; package dependencies and lockfile.

- [x] Add manual/auto approval mode persisted as metadata independently of Tool Permission; default manual, fork preserves mode.
- [x] Configure reviewer conversation/custom-model with existing routes and dedicated endpoint credentials; validate/sanitize API responses without exposing keys.
- [x] Compose all three runtime paths; requester agentId resolves its own Session; narrower child permission does not inherit parent auto elevation.
- [x] Include config in runtime signatures; mode/config edits take effect without stale provider; abort propagates to reviewer.

## Task 4: Frontend and verification

Files: Composer, SettingsDialog, Session/Project run settings, web API types and tests.

- [x] Add Approvals Choice (Ask me / Auto review) and reviewer settings reusing existing controls.
- [x] Show pending/review audit states within established activity styles, keep manual fallback usable.
- [x] Run affected tests, root typecheck/lint/build and package-entry tests where needed; inspect rendered UI and fix regressions.
- [x] Review complete branch against user requirements, commit features, report exact API ambiguity if still unresolved.

## Baseline verification

`pnpm test -- packages/cli/test/web.test.ts` reports six failures. Read-only comparison used `git archive HEAD` in a temporary workspace directory, explicit Vitest aliases for every archived `@tnega/*` source package, and dependency junctions. The unchanged HEAD reproduced the execute-mode PATCH, SSE disconnect, plan message-start, plan request-count, and slash-command failures. Running the stop-endpoint case alone against both archived HEAD and current source reproduced the same outdated `cancelled` expectation versus durable `interrupted` result. These failures predate this branch; existing tests were left unchanged. The archive, temporary config, zip and dependency junctions were removed after verification.

## Final verification

Affected behavior suites: 18 files / 252 tests passed. Root typecheck, Web typecheck, and lint passed. Published plugin entries are validated by test/publish.test.ts, which performs the full JS/Web/declaration build. Browser review used a temporary empty workspace and configuration; narrow Settings layout remains scrollable with reachable footer. No paid provider API calls were made; protocol, confidence, missing-key and cancellation paths use injected HTTP/LLM mocks.


# Session Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the selected tool-permission mode in each Session and apply it to later Agent Runs without rebuilding a resident runtime when the mode changes.

**Architecture:** Add a durable `permission/mode` Session event and a pure fold with a fail-safe `read-only` default. The Web API writes that event through the session PATCH route; each execution and tool-authorization call resolves the current mode from the Session immediately before acting.

**Tech Stack:** TypeScript, Node.js, Vitest, Cordis Context, JSONL Session logs.

**Spec:** `CONTEXT.md`; `docs/adr/0008-sandbox-seam.md`.

## Global Constraints

- Permission modes remain `read-only`, `workspace-write`, and `bypass`.
- Sandbox modes only govern file writes; network stays outside this vocabulary.
- Unknown or absent persisted values fold to `read-only`.
- Session logs stay append-only and replayable.

---

### Task 1: Durable Session permission state

**Files:**
- Modify: `packages/session/src/index.ts`
- Modify: `packages/cli/src/store.ts`
- Test: `packages/cli/test/store.test.ts`

- [ ] Write a failing test proving a `permission/mode` event updates a summary and survives reopening the JSONL Session.
- [ ] Run `pnpm test -- packages/cli/test/store.test.ts` and confirm the missing event/fold causes failure.
- [ ] Add the closed event vocabulary, pure fold, store setter, and summary projection.
- [ ] Re-run the store test and confirm it passes.
- [ ] Commit the independently reviewable durable-state change.

### Task 2: Dynamic execution and authorization policy

**Files:**
- Modify: `packages/sandbox/execution-sandbox/src/index.ts`
- Modify: `packages/sandbox/execution-sandbox/test/execution-sandbox.test.ts`
- Modify: `packages/cli/src/permissions.ts`
- Modify: `packages/cli/test/web.test.ts`

- [ ] Write failing tests proving an execution provider and guard use a current policy resolver rather than the runtime construction value.
- [ ] Run the focused tests and confirm they fail for the static policy behavior.
- [ ] Permit policy resolution immediately before process confinement and authorization, preserving the static configuration API.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit the independently reviewable dynamic-policy change.

### Task 3: Web and Resident runtime integration

**Files:**
- Modify: `packages/cli/src/server.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/conversation/ChatView.tsx`
- Test: `packages/cli/test/web.test.ts`

- [ ] Write failing API coverage for PATCHing a Session permission and starting a Run without a permission request field.
- [ ] Run the focused web test and confirm it fails.
- [ ] Persist UI selections through PATCH, resolve the Session mode for every Run, and remove permission from the resident runtime cache key.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Run `pnpm typecheck` and the relevant Web test.
- [ ] Commit the integration change.

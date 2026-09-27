# Project Thread Permission Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Project coordinator raise a direct child Thread's permission through an explicit model-visible tool.

**Architecture:** Add a Thread Service operation that atomically verifies the direct parent relationship and caps the requested mode at the coordinator's own permission before committing the Thread record. The new tool is deliberately absent from the Project guard's automatic allow-list, so `read-only` and `workspace-write` calls require ApprovalBroker consent while `bypass` proceeds directly.

**Tech Stack:** TypeScript, Cordis, Blackboard, Vitest.

**Spec:** `CONTEXT.md`; `packages/project/thread/README.md`; `packages/cli/src/permissions.ts`.

## Global Constraints

- A child permission can never exceed its direct parent's persisted permission.
- Only the coordinator may approve a direct child.
- `bypass` is the only mode that skips ApprovalBroker.
- Thread records remain the durable source of their permission.

---

### Task 1: Thread permission-grant domain operation

**Files:**
- Modify: `packages/project/thread/src/index.ts`
- Modify: `packages/project/thread-local/src/index.ts`
- Test: `packages/project/thread-local/test/thread.test.ts`

- [ ] Write a failing test for promoting a direct child to its parent's permission and rejecting a requested mode above that parent.
- [ ] Run `pnpm test -- packages/project/thread-local/test/thread.test.ts` and confirm the new operation is absent.
- [ ] Add the typed service operation and atomic Blackboard update.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Coordinator approval tool

**Files:**
- Modify: `packages/project/tool-thread/src/index.ts`
- Modify: `packages/project/tool-thread/README.md`
- Test: `packages/project/tool-thread/test/tool-thread.test.ts`

- [ ] Write a failing test for the `approve_thread_permission` tool calling the domain operation only for the coordinator and a direct child.
- [ ] Run the focused test and confirm it fails because the tool is missing.
- [ ] Register the explicit tool without adding it to `ALWAYS_ALLOWED`.
- [ ] Re-run the focused test and confirm it passes.

- [ ] Run `pnpm typecheck` and focused Thread/tool tests.
- [ ] Commit with `feat: approve project thread permissions`.

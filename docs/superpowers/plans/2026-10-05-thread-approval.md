# Thread approval implementation plan

**Goal:** Resume an exact waiting Thread tool call after its direct parent decides, without relying on the Thread to forward an error.

**Architecture:** A Project-scoped broker owns bounded, cancellable pending calls. It sends a durable Box request to the direct parent and registers `decide_thread_approval`. Only `ask` falls back to delegation; reviewer `deny` remains denied. Parent decisions never become human authorization evidence. Requests and outcomes are audited in the requesting Session; pending execution is not restored after process restart.

**Tech stack:** TypeScript, existing Box/Thread/Tools services, Vitest.

**Constraints:** Preserve permission presets, sandbox fail-closed behavior, trusted human evidence and Fiber disposal. No new dependencies or public package exports.

## Implementation

- [x] Add behavioral tests in `packages/cli/test/thread-approval.test.ts`: exact-call resume through Box and the parent tool, reject unrelated callers and repeated decisions, deny/cancel/timeout/dispose without execution, human escalation through ApprovalBroker.
- [x] Run `pnpm test -- packages/cli/test/thread-approval.test.ts` and observe the missing delegation path.
- [x] Add `packages/cli/src/thread-approval.ts`, wire its request callback into `permissionGuard` and mount it in ProjectHost. Keep review denial terminal, and never treat ordinary messages as permission decisions.
- [x] Exercise the real Project Loop with a deterministic LLM adapter to prove the parent is awakened and its decision resumes the original child call once.
- [x] Update coordinator/Thread instructions, CLI documentation, CONTEXT and CHANGELOG Unreleased.
- [x] Run focused tests, `pnpm typecheck`, and lint for the changed code; inspect the diff and commit only this feature with Conventional Commits.

The key acceptance assertion is `expect(executions).toBe(1)` after a Box-delivered request leads the direct parent to call `decide_thread_approval`, and `expect(executions).toBe(0)` for rejected, cancelled, stale or unauthorized requests. The tests use real services and durable Sessions; only model completion is deterministic.

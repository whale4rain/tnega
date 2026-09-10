# DSH P1 Agent-Semantic Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tnega's live agent scheduling, scoped runtime, request retry and cancellation semantics satisfy every P1 requirement in the approved DSH alignment design.

**Architecture:** A live-agent wake reservation preserves the semantic difference between steer and inject across idle and abort boundaries. The agent service is scope-owned and uses immutable per-step request inputs so all request attempts build through the same stream path. The serial tool executor settles every declared call after cancellation and transcript validation becomes a mandatory request invariant.

**Tech Stack:** TypeScript, Vitest, `@tnega/core`, `@tnega/agent`, `@tnega/session`, `@tnega/tools`.

**Spec:** `docs/superpowers/specs/2026-09-11-dsh-p1-semantic-alignment-design.md`

## Global Constraints

- Preserve `LiveAgent.inject(input: AgentInput)`; do not restore a key/value injection public API.
- Do not alter `SESSION_FORMAT_VERSION` or add DSH `UserMessage.source`.
- `run()` and `runStream()` must prefer `LLMAdapter.stream()` and use `complete()` only if stream is absent.
- Every retry starts from an immutable admitted step transcript and recovery sees the failed attempt's final routed envelope.
- A failed non-cancelled stream must not become assistant history for its retry.
- Every P1 behavior gets a focused regression test before production code.
- Commit each independently testable implementation task with a Conventional Commit subject of 72 characters or fewer.

---

### Task 1: Wake reservation and abort-safe live scheduling

**Files:**
- Modify: `packages/agent/src/live.ts`
- Test: `packages/agent/test/live.test.ts`

**Interfaces:**
- Consumes: durable `next-turn` / `next-step` queues and `LiveAgent.followup`, `steer`, `inject`, `cancel`.
- Produces: a private wake reservation that grants one driver turn for waking sends but never for idle injects.

- [ ] **Step 1: Write failing live scheduling tests**

```ts
it('opens one turn for idle steer while idle inject remains inert', async () => {
  handle.agent.steer({ text: 'steer now' })
  await handle.agent.whenIdle()
  expect(requests).toEqual([['steer now']])
})

it('runs steer submitted after abort as a later turn', async () => {
  handle.agent.followup({ text: 'active' })
  await running
  handle.agent.cancel({ type: 'user' }, { keepInbox: true })
  handle.agent.steer({ text: 'after abort' })
  await handle.agent.whenIdle()
  expect(requests).toContainEqual(expect.arrayContaining(['after abort']))
})
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run: `pnpm exec vitest run packages/agent/test/live.test.ts`

Expected: idle steer receives no model call and/or abort-window steer remains pending.

- [ ] **Step 3: Implement reservation-based draining**

```ts
// In LiveAgentImpl, track a private wake reservation.
// followup/steer reserve one turn; inject never reserves one.
// If a waking input arrives after the active controller is aborted, append it
// to next-turn and preserve the reservation until the drain becomes idle.
// Consume a reservation only when _streamTurns opens its first turn.
```

- [ ] **Step 4: Verify live scheduling tests pass**

Run: `pnpm exec vitest run packages/agent/test/live.test.ts`

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/agent/src/live.ts packages/agent/test/live.test.ts
git commit -m "fix(agent): preserve steer wake semantics"
```

### Task 2: Scope-bind the live agent runtime

**Files:**
- Modify: `packages/agent/src/live.ts`
- Test: `packages/agent/test/live.test.ts`

**Interfaces:**
- Consumes: `AgentCreationOptions.setup`, `Context.inject`, service registration and `AgentService` constructor.
- Produces: service, event dispatch, LLM lookup and tool lookup resolved from the per-agent scope.

- [ ] **Step 1: Write failing scope-isolation tests**

```ts
it('uses an LLM and llm/stream middleware installed by agent setup', async () => {
  const handle = await createHandle(root, file, rootLlm, undefined, (agentCtx) => {
    agentCtx.provide('llm', scopedLlm)
    agentCtx.on('llm/stream', routeScopedRequest)
  })
  handle.agent.followup({ text: 'scoped' })
  await handle.agent.whenIdle()
  expect(scopedCalls).toBe(1)
  expect(rootCalls).toBe(0)
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run packages/agent/test/live.test.ts`

- [ ] **Step 3: Construct runtime objects from the agent scope**

```ts
// Create the agent scope before AgentService.
// Construct AgentService and LiveAgentImpl with scopeCtx, retaining root only
// for registry ownership and lifecycle publication where required.
// Keep setup's existing teardown semantics.
```

- [ ] **Step 4: Run scope and complete live tests**

Run: `pnpm exec vitest run packages/agent/test/live.test.ts`

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/agent/src/live.ts packages/agent/test/live.test.ts
git commit -m "fix(agent): run live agents in their scoped context"
```

### Task 3: Unify native stream, replay and retry attempts

**Files:**
- Modify: `packages/agent/src/service.ts`
- Test: `packages/agent/test/agent.test.ts`

**Interfaces:**
- Consumes: `LLMAdapter.stream`, `LLMAdapter.complete`, `agent/request`, `llm/stream`, `agent/request-error`.
- Produces: immutable per-step input, attempt-final recovery payload, mandatory transcript guard.

- [ ] **Step 1: Write failing request-pipeline tests**

```ts
it('uses native stream for run when the adapter supplies one', async () => {
  await service.run({ text: 'go' })
  expect(streamCalls).toBe(1)
  expect(completeCalls).toBe(0)
})

it('rebuilds retry requests without carrying a failed partial response', async () => {
  // First stream yields a delta then fails; retry succeeds.
  // The second adapter request equals the original admitted transcript.
})

it('re-enters request waterfalls and gives recovery the final routed envelope', async () => {
  // Route provider/model differently per attempt and assert the error hook
  // observes the first routed provider while the succeeding log has the second.
})

it('rejects unowned assistant or tool transcript mutations without opt-in', async () => {
  // A llm/stream listener appends an assistant message and service.run rejects.
})
```

- [ ] **Step 2: Run the tests and verify failures**

Run: `pnpm exec vitest run packages/agent/test/agent.test.ts`

- [ ] **Step 3: Refactor request attempts around immutable admitted input**

```ts
// Always select llm.stream when it exists.
// Retain the post-pre-step admitted messages as the retry base.
// Re-run agent/request then llm/stream on every retry and persist the final
// attempt envelope. Only cancellation may append an interrupted assistant prefix.
// Validate the complete post-waterfall message roles/order against durable history
// on every request; retain assertReplayable only as an additional diagnostic alias.
```

- [ ] **Step 4: Run request-pipeline and full agent tests**

Run: `pnpm exec vitest run packages/agent/test/agent.test.ts`

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/agent/src/service.ts packages/agent/test/agent.test.ts
git commit -m "fix(agent): stabilize stream retry requests"
```

### Task 4: Settle cancelled tool batches durably

**Files:**
- Modify: `packages/agent/src/service.ts`
- Test: `packages/agent/test/agent.test.ts`

**Interfaces:**
- Consumes: `LLMCompletion.toolCalls`, `ToolsService.execute`, turn cancellation signal.
- Produces: a `tool/call` and `tool/result` pair for every declared tool call, including synthetic aborted results.

- [ ] **Step 1: Write a failing cancelled multi-tool test**

```ts
it('records synthetic aborted results for calls not started after cancellation', async () => {
  // First tool aborts the signal. Completion declares first and second calls.
  // Assert two tool/call and two tool/result events; second execute never runs.
  // Assert the second result is an aborted failure.
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run packages/agent/test/agent.test.ts`

- [ ] **Step 3: Add serial cancellation settlement**

```ts
// Before dispatching each call, inspect signal.aborted.
// For every remaining call append tool/call followed by a failed tool/result
// whose error represents the cancellation cause, without calling execute().
```

- [ ] **Step 4: Run agent and session suites**

Run: `pnpm exec vitest run packages/agent/test packages/session/test`

- [ ] **Step 5: Commit Task 4**

```bash
git add packages/agent/src/service.ts packages/agent/test/agent.test.ts
git commit -m "fix(agent): settle cancelled tool batches"
```

## Final verification

- [ ] Run `pnpm exec vitest run packages/agent/test packages/session/test`.
- [ ] Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
- [ ] Run `pnpm test` and report external credential-dependent smoke failures separately.

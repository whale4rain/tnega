# DSH Remaining Agent Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` task-by-task.

**Goal:** Close the remaining requested DSH observable Agent Run semantics without mixing in the deliberately deferred parallel-tool scheduler.

**Architecture:** Keep `AgentService` as the loop driver, but make its step transition consume an already-admitted `next-step` even when a tool concludes the current response. Add a DSH-shaped durable assistant-attempt settlement to `@tnega/session`; the loop owns lifecycle-local attempt ids and monotonically revised live frames, while the terminal durable attempt preserves the complete normalized stream for replay. Make durable-inbox mutation completion observable through promise-returning live-agent methods.

**Tech Stack:** TypeScript strict mode, Vitest, `@tnega/agent`, `@tnega/session`, `@tnega/core`.

**Spec:** `docs/research/dsh-agent-core-current-alignment-audit.md`

## Global Constraints

- Preserve the model-visible-history invariant: every model-visible message remains reconstructable from Session durable events.
- Preserve `LiveAgent.inject(input: AgentInput)` and its inert-idle semantics.
- A Session format extension is a deliberate format boundary: increment the format version and reject older logs rather than silently reinterpret them.
- Do not implement parallel/exclusive tool scheduling in this work.
- Add a focused failing behavior test before each production change and commit each independently testable task with a Conventional Commit subject of at most 72 characters.
- Do not stage unrelated user changes in `.gitignore`, `task.md`, or the existing research audit.

---

### Task 1: Consume queued next-step after a concluding tool

**Files:**
- Modify: `packages/agent/src/service.ts`
- Modify: `packages/agent/test/live.test.ts`

**Interface:** A `concludesTurn` result prevents a further tool-driven continuation, but it does not discard or defer a `claimNextStep()` input which was durably admitted before the step boundary.

- [ ] Add a live-agent regression where a concluding tool calls `inject({ text: 'same turn' })`; assert a second model request includes the injected text and both requests share one durable `turn/start`.
- [ ] Run `pnpm exec vitest run packages/agent/test/live.test.ts` and observe the assertion fail because the input remains pending.
- [ ] Move the `claimNextStepMessages()` transition before the `concludesTurn` stop decision. Stop only when `concludesTurn` is true **and** no next-step input was claimed; retain the existing no-tool stopping-listener behavior.
- [ ] Re-run the live suite and commit only the service and live-test change as `fix(agent): claim next-step after concluding tool`.

### Task 2: Add a durable assistant-attempt ledger

**Files:**
- Modify: `packages/session/src/index.ts`
- Modify: `packages/session/src/invariant.ts`
- Modify: `packages/session/test/session.test.ts`
- Modify: `packages/session/test/invariant.test.ts`
- Modify: `packages/session/README.md`
- Modify: `docs/adr/0005-assistant-attempt-ledger.md`

**Interface:** `SessionLog` accepts a terminal `assistant/attempt` event with `{ turn, step, stream }`, where `stream` is the ordered normalized stream record for an attempt that settled without an `assistant/message`. It is log-only and does not enter the model surface. An Agent lifecycle's transient attempt id/revision is deliberately not used as a Session identity.

- [ ] Add failing Session tests for append/reopen preservation of a failed normalized stream attempt and for its exclusion from `deriveMessages()`; add invariant failures for an attempt outside an open step or with an invalid stream record.
- [ ] Run `pnpm exec vitest run packages/session/test/session.test.ts packages/session/test/invariant.test.ts` and confirm failures are caused by unknown event types / absent invariants.
- [ ] Introduce Session-owned normalized stream-record types and typed append overloads, include attempt events in the event union and no-surface projection, and advance `SESSION_FORMAT_VERSION` from 7 to 8. Implement attempt ownership and stream-record validation in the session invariant module.
- [ ] Record ADR 0005: the terminal durable attempt preserves a failed/retried/cancelled stream without fabricating model-visible history; provider input is normalized before logging. Document v7 rejection and the explicit no in-place migration policy.
- [ ] Re-run the session suites and commit as `feat(session): record durable assistant attempts`.

### Task 3: Settle attempts from the Agent Run stream and expose reconnect state

**Files:**
- Modify: `packages/agent/src/service.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/test/agent.test.ts`
- Modify: `packages/session/src/index.ts`
- Modify: `packages/session/test/session.test.ts`
- Modify: `packages/agent/README.md`

**Interface:** Each adapter invocation allocates a fresh lifecycle-local attempt id before stream consumption and publishes start/chunk/end Agent Stream Events with a strictly monotonic revision. Normal completion commits `assistant/message` with its normalized stream; retry failure, cancellation without a committed message, and stream exceptions commit exactly one terminal `assistant/attempt` carrying the normalized stream. A reconnect consumer can replay committed assistant-message and attempt streams, while live frames can de-duplicate by `(attemptId, revision)`.

- [ ] Add failing Agent tests for: a failed stream commits one terminal attempt; a retry creates a distinct attempt id and fresh revisions; cancellation settles a terminal attempt; normal completion commits an assistant message and emits an end frame after durable commit.
- [ ] Add a failing Session test for a reconnect projection/helper that returns normalized streams from committed assistant-message and attempt events in durable order.
- [ ] Run the focused agent and session tests; verify that no attempt facts or lifecycle frames exist before implementation.
- [ ] Extract attempt framing behind a private `AgentService` helper so the stream loop never hand-manages revisions. Emit start before consumption, emit chunk frames in provider order, and emit the terminal frame only after `assistant/message` or `assistant/attempt` commits. Add optional normalized stream data to `assistant/message`; keep existing `assistant/chunk` events as a compatibility projection, not the attempt source of truth. Define and export the reconnect projection from `@tnega/session`.
- [ ] Re-run focused tests plus `pnpm exec vitest run packages/agent/test packages/session/test`; commit as `feat(agent): settle reconnectable stream attempts`.

### Task 4: Make durable inbox mutation completion and targets exact

**Files:**
- Modify: `packages/agent/src/live.ts`
- Modify: `packages/agent/test/live.test.ts`
- Modify: `packages/agent/README.md`

**Interface:** `followup`, `steer`, `inject`, `send`, `replaceMessage`, and `removeMessage` return `Promise<void>`. Resolution means the splice is durable and its live observation was emitted; rejection returns the persistence failure. `agent/inbox/inserted.target` reflects `followup`, `steer`, or `inject`, and replacement retains the original durable queue target.

- [ ] Add failing tests for replacement in `next-step`, inject observation target, and a forced `DurableInbox` append failure which rejects the caller promise rather than only emitting `agent/error`.
- [ ] Run the live suite and verify failure against the current void API / post-replace lookup.
- [ ] Make the write tail preserve errors for the initiating call while remaining usable by subsequent writes. Capture the replacement target before splice, and separate public intent (`inject`) from durable queue placement (`next-step`) in event payload typing.
- [ ] Re-run the suite and commit as `fix(agent): expose durable inbox mutation results`.

### Task 5: Support asynchronous pre-step and request middleware

**Files:**
- Modify: `packages/agent/src/service.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/test/agent.test.ts`
- Modify: `packages/agent/README.md`

**Interface:** `agent/pre-step` and `agent/request` use the async waterfall seam; synchronous listeners retain their existing behavior. The step cannot append `step/start` or call an adapter until the asynchronous transformation resolves.

- [ ] Add failing tests with an awaited pre-step rewrite and an awaited request route/tool rewrite; assert the adapter receives the awaited final envelope and the durable request snapshots match it.
- [ ] Run `pnpm exec vitest run packages/agent/test/agent.test.ts` and observe that the current synchronous waterfall does not await the listeners.
- [ ] Replace only the two waterfall dispatch sites with `waterfallAsync`, preserve their fallback payload contracts, and update event handler types only as required for promise listeners.
- [ ] Run the focused suite and commit as `feat(agent): await pre-step request middleware`.

### Task 6: Scope Session event dispatch to the owning Agent

**Files:**
- Modify: `packages/agent/src/live.ts`
- Modify: `packages/session/src/index.ts`
- Modify: `packages/agent/test/live.test.ts`

**Interface:** A SessionLog may receive an owning Context for its live `session/event` and `session/flush` publication; its durable file and replay behavior remain unchanged. A setup-scoped listener observes its own Agent's Session events and not a sibling Agent's.

- [ ] Add a failing two-live-agent scope test that installs a `session/event` listener in one setup scope and verifies it observes only that Agent Run.
- [ ] Implement an optional publication-context seam at SessionLog construction and construct the live-agent session through its agent scope.
- [ ] Run the live and session suites and commit as `fix(agent): scope live session event dispatch`.

### Task 7: Serialize and atomically claim durable inbox work

**Files:**
- Modify: `packages/agent/src/inbox-durable.ts`
- Modify: `packages/agent/src/live.ts` only where claim integration requires it
- Modify: `packages/session/src/index.ts`
- Modify: `packages/agent/test/inbox-durable.test.ts`
- Modify: `packages/agent/test/live.test.ts`
- Modify: `packages/session/test/session.test.ts`
- Modify: `packages/session/README.md`

**Interface:** Every durable inbox state transition—insert, steer, replace, remove, clear, `claimNextStep`, and `claimBatch`—is serialized inside `DurableInbox`, not merely at live public call sites. A mixed next-step/next-turn batch claim commits as one append-only splice fact or leaves both queues unchanged; a rejected claim never loses model-visible work.

- [ ] Add failing concurrent-operation regressions: `steer(B)` racing `claimNextStep()` after `A`, and replacement racing a claim. Assert each message is claimed once and no stale input remains or resurrects.
- [ ] Add a failing mixed-batch append failure regression: a rejected atomic claim keeps both queues and produces no unowned model input.
- [ ] Run the focused inbox/live/session suites and record RED.
- [ ] Introduce a private `DurableInbox` operation tail covering the entire snapshot → append → apply transition. Extend the v9 all-queue splice representation only as necessary to encode atomic claim deletion; advance the Session format version and reject v9 rather than reinterpret it.
- [ ] Re-run focused suites and typecheck, then commit only task files as `fix(agent): serialize durable inbox claims`.

### Task 8: Settle stream-declared failures and abandoned attempts

**Files:**
- Modify: `packages/agent/src/service.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/test/agent.test.ts`

**Interface:** A normalized `message_stop` with `finishReason: 'error'` or `'cancelled'` follows the same terminal attempt and request-error path as a thrown stream failure; it cannot become a model-visible assistant message or execute tools. If durable settlement itself rejects, the live attempt emits one `abandoned` end frame.

- [ ] Add RED tests for an error stop, cancelled stop, and rejected attempt settlement.
- [ ] Route declared terminal failures through the existing retry path and expand the end-frame outcome union with `abandoned`.
- [ ] Run agent tests and commit `fix(agent): settle declared stream failures`.

### Task 9: Contain Live Agent claim failures and close owned Sessions

**Files:**
- Modify: `packages/agent/src/live.ts`
- Modify: `packages/agent/test/live.test.ts`

**Interface:** A failed durable claim reports `agent/error`, preserves/re-establishes any steer wake reservation without unhandled drain rejection, and later successful work can run. Disposing a factory-owned live Agent flushes and closes its SessionLog before resolving.

- [ ] Add RED tests for failed steer claim recovery and dispose flushing a pending owned Session.
- [ ] Contain claim errors at the drain boundary; only consume wake reservation after successful claim. Close the owned log exactly once during handle disposal.
- [ ] Run live/session tests and commit `fix(agent): recover live claim failures`.

### Task 10: Align remaining turn scheduling and observation details

**Files:**
- Modify: `packages/agent/src/inbox-durable.ts`
- Modify: `packages/agent/src/live.ts`
- Modify: `packages/agent/src/service.ts`
- Modify: `packages/agent/test/inbox-durable.test.ts`
- Modify: `packages/agent/test/live.test.ts`
- Modify: `packages/agent/test/agent.test.ts`

**Interface:** Steers retain FIFO order; every durable next-step claim emits a claimed observation; concluding tools give `agent/turn-stopping` an opportunity to enqueue same-turn work; once any step reports `length`, the Agent Run keeps that final reason across later continuation.

- [ ] Add RED tests for each boundary.
- [ ] Implement only these ordering/notification/reason transitions, retaining v10 event compatibility.
- [ ] Run agent/session tests and commit `fix(agent): align remaining turn scheduling`.

## Final Verification

- [ ] Run `pnpm exec vitest run packages/agent/test packages/session/test`.
- [ ] Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
- [ ] Run `pnpm test`; separately report any credential-dependent smoke skips/failures.
- [ ] Review the resulting diff against this plan and the DSH audit before requesting integration.

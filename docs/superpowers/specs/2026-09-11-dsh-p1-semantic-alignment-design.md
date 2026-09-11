# DSH P1 Agent-Semantic Alignment Design

## Goal

Close every P1 gap listed in `docs/research/dsh-agent-core-post-alignment-audit.md` while preserving tnega's `AgentInput` model and v5 session format.

## Scope

- A wake reservation distinguishes `steer()` from inert `inject()`: idle steer opens one turn; idle inject waits; post-abort waking input is claimed as a new turn.
- Every live-agent execution service is constructed in its agent scope, so setup-registered LLM, tools, and middleware are isolated to that agent.
- Both `run()` and `runStream()` use `LLMAdapter.stream()` when available and normalize `complete()` only as a fallback.
- A retry restarts from the immutable admitted step transcript, rebuilds the `agent/request` and `llm/stream` envelopes, and never promotes a failed non-cancellation partial assistant stream into model history.
- Cancellation produces durable results for every declared model tool call: started calls settle normally; not-started calls receive synthetic aborted results.
- Every post-waterfall request is checked against the reconstructable session transcript by default. A waterfall may replace the transcript, but cannot add assistant/tool messages that have no durable session owner.

## Non-goals

- Do not add DSH's rich `UserMessage.source` object, stream reconnect transport, or a session-format version.
- Do not implement DSH parallel/exclusive tool scheduling in this pass; the required cancellation settlement applies to the existing serial executor.
- Do not change public `LiveAgent.inject(input: AgentInput)` back to a key/value API.

## Architecture

`LiveAgentImpl` owns a small wake-state token alongside its durable inbox. `followup` and `steer` create a wake token, while `inject` only appends `next-step`. A token grants one turn boundary even when there is no `next-turn` message; after abort, a waking input is redirected to `next-turn` and latched until the current drain converges.

`buildHandle` creates the agent scope before it constructs `AgentService` and `LiveAgentImpl`. The scoped context is the only context used for events, LLM lookup, tools, system prompt and setup registrations.

`AgentService` keeps an immutable admitted transcript for each step. Each attempt re-runs `agent/request` and `llm/stream` from a copy of that transcript. Failed non-cancelled attempts write durable retry facts but no assistant history; cancelled attempts retain their existing interrupted-prefix behavior. The request guard validates the complete allowed transcript after every waterfall and rejects unsupported inserted roles.

The serial tool executor observes cancellation before each new tool call. Calls not yet begun receive a durable failed `tool/result` with an abort error after their corresponding `tool/call`; this keeps the assistant's declared calls and session facts balanced.

## Error Handling

- A durable inbox append error is surfaced through the existing agent error channel and must not set a wake reservation.
- A failed request retry sees the final failed attempt's provider/model/tools/options, not the first proposal.
- A retry listener can change route or request options; the persisted header/context always reflect the final successful attempt.
- A transcript guard failure ends the open step/turn with the existing error settlement path.

## Verification

- Live tests cover idle steer, idle inject, abort-window steer, and scoped setup middleware/tool isolation.
- Agent tests cover `run()` choosing native stream, retry re-entry without accumulated waterfall messages, final recovery envelope, failed partial stream isolation, mandatory replay guard, and synthetic cancelled tool results.
- Run `packages/agent/test`, `packages/session/test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test`; report external credential smoke failures separately if present.

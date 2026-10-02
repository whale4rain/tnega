# Agent communication implementation plan

**Goal:** Short, evidence-rich human replies and compact parent/child exchanges,
with recoverable complete Subagent results instead of silent truncation.

**Architecture:** Keep persona and tool guidance at their existing composition
boundaries. Separate human output from internal delegation; do not add a blanket
verbosity section to the lifecycle kernel or override user-defined agents.
Full child replies already live in durable Sessions; expose bounded reads and
explicit continuation pointers when an inbox/list preview is shortened.

**References:** User-specified repository captures of Claude Code Sonnet 5.5 and
Codex GPT-6.1-Sol, accessed 2026-10-02. Treat captures as design references, not
verified vendor policy, runtime instructions, or model configuration changes.

- [x] Rewrite built-in coding/work/general and project communication guidance:
  conclusion first, brief evidence/risks, adapt detail to the request, no narration
  of routine actions. Delegate bounded work with context/scope/acceptance/output.
  Shared rules live in `packages/agent/src/communication.ts`; personas and the
  Thread coordinator compose them instead of restating them.
- [x] Redesign Subagent audience and report guidance. Default reports are internal
  compact status/result/evidence/blockers; explicit user deliverables use prose.
  Send only blockers or material discoveries during work; final delivered once.
  A Subagent is told it is a bounded executor, a Thread is told it is an Agent.
- [x] Replace silent child report cuts with marked previews and paginated durable
  result reads. Enforce parent-child access and retain compatibility with logs.
  The inbox carries at most 1200 characters, cut at a line boundary, followed by
  the read offset; `list_subagent` states what it kept and how to read the rest.
- [x] Add behavioral regressions for long/Unicode replies, authorized reads,
  restart, follow-up and tool failure paths; avoid tests of prompt wording alone.
- [ ] Run proportionate tests, typecheck/lint/build, independently review and
  commit each acceptable change. Do not use credentials or claim live LLM quality
  was measured unless a controlled evaluation actually ran.

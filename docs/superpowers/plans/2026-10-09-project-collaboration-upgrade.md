# Project Collaboration Upgrade Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent runtime tasks, with root integration and review.
> 状态：实现已落盘；按用户要求停止后续验证与测试，最终温度修复未经验证
> 取代关系：补充 `docs/research/2026-10-09-project-collaboration-controls.md`；用户明确选择 Git 并行写与每 Thread PR，替代其单写者优先建议
> 当前实现：`packages/cli/src/project-host.ts`、`packages/project/thread-local/src/index.ts`、`apps/web/src/components/project/`

**Goal:** Bounded asynchronous memory, isolated parallel coding Threads with PR delivery, concise fully visible coordination, and artifact editing conversations.

**Architecture:** Keep Coordinator dispatch-only. Memory side requests fork a completed request prefix without mutating the source Session; delayed extraction uses an explicitly configured economical route. Each coding Thread owns a Git worktree/branch and a PR. Artifacts open with their associated Thread in a two-column dialog; quoted selections become grounded user messages.

**Tech Stack:** Existing TypeScript services, JSONL, React, Git/gh, pnpm.

**Spec:** User instructions in this chat, `docs/design/tnega-design.md`, Project research and current package READMEs.

## Constraints

- Do not modify CI or release configuration, push this repository, or rewrite v0.4.24.
- Keep source Session unchanged during memory extraction; reuse exact completed request prefix when possible, do not promise cache hits. Budget reservations assume uncached input, cap calls/input/output and daily usage; no unbounded retries or recursive memory-triggered extraction.
- Alternative memory model is user-configurable from existing routes; unavailable or unpriced routes fail closed for cost-based budgets, never silently choose an expensive fallback.
- Code work owns a per-Thread working directory across all file/execution/search/artifact consumers, not only shell cwd. Parent/child permissions remain narrowing. Non-Git work does not invent a remote or PR.
- PR failures remain actionable and visible; never claim a PR exists without successful creation. No forced pushes or automatic merges.
- Artifact ownership stays with the generating Thread across content revisions. A Thread may manage multiple artifacts; opening an artifact must not create a Thread or start a Run.
- Coordinator output is never shortened by Show more. All Agent communication defaults concise, except user-requested detail and actual deliverables.
- Independent verified units get separate Conventional Commits and Unreleased notes; preserve other agents' files.

## Tasks

- [ ] Memory runtime: new `packages/cli/src/project-memory.ts` and tests; configuration parsing, API snapshot/settings fields and UI. A bounded side request consumes completed Run evidence, returns structured memory candidates, commits with source/dedup, records cost reservation and outcome. Root integrates host hook after runtime helper review.
- [ ] Git execution: per-Thread worktree lifecycle, scope-local tool composition, durable workspace/branch/PR metadata and PR delivery. Integration tests use temporary local repos and mocked GitHub commands; no external PRs during development. Ownership: Git worker owns Project Host/thread runtime; coordinate memory hook with root.
- [ ] Artifact interaction: root owns `Artifacts`, `ProjectView`, `ThreadPanel`, Project routes/API/model and artifact data contract. Update design before UI; open dialog with preview left and Thread conversation right; selection includes artifact identity/hash and quote, submitted only when user sends. Verify ownership and stale versions server-side.
- [ ] Prompt and display: remove room folding; strengthen shared communication instruction without hiding durable messages or shortening artifacts. Update Project role prompts without conflicting Git worker edits.
- [ ] Integration: scoped behavioral tests, typecheck/lint/build as appropriate; actual browser verification across required appearance settings; final review and commits. Record all limitations accurately.

## Review cases

Memory: repeated completed event, budget exhaustion, missing price/model, cancellation/restart, malformed extraction, delayed route, no source Session mutation. Git: concurrent spawn, restart reuse, original checkout unchanged, non-Git workspace, missing origin/auth, PR retry reuses branch/PR, tool paths and artifacts remain correct. UI: long Coordinator reply fully rendered; open correct Thread; selected quote plus user instruction delivered once with correct artifact version; edits keep artifact identity; cancel leaves no sent message.

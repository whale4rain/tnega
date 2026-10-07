# Compact Project Chat Implementation Plan

**Goal:** Match the supplied chat references with smaller typography, short consecutive bubbles, inspectable Agent exchanges and working file/site references.

**Architecture:** Keep Box envelopes as the chat source and Session as the execution source. Project communications become compact timeline receipts that open a separate Workbench document showing only the selected Agent pair. Existing Thread tabs retain direct user chat and execution details.

**Tech Stack:** React, CSS tokens, Vitest, playwright-core (local opt-in E2E).

## Constraints

- Preserve weather identities, both themes and contrast floors.
- No new persistence format or dependencies; additive snapshot field for Agent exchanges, older servers remain supported.
- E2E is a local command under apps/web/e2e, outside Vitest discovery and CI.
- Verify and commit each independently reviewable feature; preserve unrelated changes.

## Tasks

- [x] Reduce shared typography and tighten Session/Project bubbles in styles/tokens.css, app.css and project.css; update design section 5.1 and run contrast tests.
- [x] Add pairwise exchange projection and snapshot envelopes in project-model.ts and project-host.ts. Test ordering, duplicates, nested Agents and reload; replace Thread cards in the room with Messaged receipts, retaining Board cards.
- [x] Open exchange documents through workbench.ts and Workbench.tsx; render sender-labelled grouped bubbles in a new project/ExchangePanel.tsx. Verify open/close and direct Thread chat still work.
- [x] Wire Project LinkContext to Files/Browser, recognize bare paths and file inline code in Markdown without touching fenced code or existing links; test navigation and unsafe/out-of-workspace references. Ordinary Session user messages now share these interactions.
- [x] Teach coordinator and Thread prompts to send separate concise messages and pass constraints, deltas, decisions and deliverable references. Preserve automatic turn-end reports and permission semantics.
- [x] Add deterministic browser E2E using intercepted API fixtures, exercise exchanges, links, typography, themes and narrow layouts; document local execution and save screenshots for visual review.
- [x] Run focused tests, typecheck, lint and build; inspect screenshots, update Unreleased and commit each completed feature.

## Verification

- 73 focused Vitest checks passed across projection, references, timeline, contrast, Project controls, host integration and prompt protocol.
- 14 optional browser checks passed: Project and ordinary Session, dark/light themes, 390px viewport, links and SSE. Eight screenshots inspected under `apps/web/e2e/.artifacts/`.
- Root `pnpm typecheck`, `pnpm lint` and `pnpm build` passed. Web-only typecheck still reports the same 11 baseline diagnostics in backend source imported by existing web tests (ES2023 APIs, undici Headers and PptxGenJS typing); a compiler-host comparison with the pre-change source confirmed no new diagnostics.
- Snapshot changes are additive; no data migration or dependency changes. Existing persisted messages are preserved. Communication brevity is a prompt default, with requested detail allowed.

## Reference findings

- [Grok Bot 101](https://x.ai/bot/guides/grok-bot-101): other Bots can message and trigger each other; persistent contexts support ongoing work.
- [Introducing dots](https://openai.com/index/introducing-dots/): ongoing goals, cross-channel context and user feedback. No public message schema is specified; our short dispatch/update/blocker/result protocol is a design inference from these principles and the user's screenshots.

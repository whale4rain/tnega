# Conversation surfaces and turn navigation

> Execute inline, task by task, with failing tests before implementation.

**Goal:** Match the supplied references: gray shell, rounded black conversation, compact sidebar, blue right-aligned user bubbles, and a turn ruler with previews.

**Architecture:** Keep existing Radix controls and shared theme tokens. ConversationNav owns accessible turn markers and previews; ChatView retains scrolling and selection. Transcript retains editing/fork behavior; CSS controls bubble geometry.

**Tech Stack:** React, Radix Themes, TypeScript, CSS, Vitest, hidden Electron fixture.

**Spec:** User screenshots and request in this task, 2026-09-22.

## Tasks

- [x] Add ConversationNav tests; replace arrows with accessible Radix Tooltip markers and connect direct selection to scrolling.
- [x] Extend the hidden Electron fixture; confirm the old full-width bubble fails before implementing the new layout.
- [x] Update theme, shell, bubbles and sidebar. Use CSS to position existing message actions below the bubble without changing their handlers. Verify wide and narrow screenshots.
- [x] Run Web/Desktop tests, scoped lint, typechecks and build; generate the Windows executable and installer.

## Constraints

- Preserve working tree changes, all session operations, keyboard focus visibility, light theme and narrow layouts.
- No new dependencies, persistence/API changes, fake tools, or interruption of running user applications.
- Generated release files remain ignored. Each independently verified change gets a Conventional Commit.

## Verification record

- Navigation tests first failed against the old arrows; all 3 now pass.
- Visual test first failed on full-width user messages; wide/narrow Electron fixture now passes, including tooltip foreground, right alignment and ruler gutter.
- Web/Desktop suite: 50 tests passed. Both typechecks, scoped Web ESLint and root build passed.
- Independent review found a narrow-layout ruler overlap; reserved a 32px gutter and added a geometry assertion.
- `pnpm package:desktop` passed; packaged stylesheet SHA256 matches the final verified build. Artifacts: `apps/desktop/release/win-unpacked/Tnega.exe` and `apps/desktop/release/Tnega Setup 0.1.0.exe`.

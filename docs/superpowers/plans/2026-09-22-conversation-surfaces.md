# Conversation surfaces and turn navigation

> Execute inline, task by task, with failing tests before implementation.

**Goal:** Match the supplied references: gray shell, rounded black conversation, compact sidebar, blue right-aligned user bubbles, and a turn ruler with previews.

**Architecture:** Keep existing Radix controls and shared theme tokens. ConversationNav owns accessible turn markers and previews; ChatView retains scrolling and selection. Transcript retains editing/fork behavior; CSS controls bubble geometry.

**Tech Stack:** React, Radix Themes, TypeScript, CSS, Vitest, hidden Electron fixture.

**Spec:** User screenshots and request in this task, 2026-09-22.

## Tasks

- [ ] Add ConversationNav interaction tests: selecting arbitrary turns, keyboard previous/next, empty/single turn, and accessible preview text. Run and observe failures, replace arrow/count controls with Radix Tooltip markers, wire onSelect to existing scrollToUserMessage, rerun and commit.
- [ ] Extend hidden Electron fixture to assert gray shell continuity, rounded main corner, right-aligned bubble width <=70%, no message border, compact session rows, and marker navigation. Run against old build to confirm failure.
- [ ] Update styles.css theme/shell/bubbles/sidebar; move user actions below text in Transcript.tsx, remove visible You label, keep accessible label. Compact sidebar top controls and project/session indentation without removing existing actions. Match desktop overlay to shell. Build, run fixture, inspect screenshots at wide/narrow sizes, and commit.
- [ ] Run Web and Desktop tests, scoped lint, typechecks and build. Package to a fresh ignored release subdirectory if an existing executable is running. Report exact executable path.

## Constraints

## Verification record

- Navigation tests first failed against the old arrows; all 3 now pass.
- Visual test first failed on full-width user messages; wide/narrow Electron fixture now passes, including tooltip foreground, right alignment and ruler gutter.
- Web/Desktop suite: 50 tests passed. Both typechecks, scoped Web ESLint and root build passed.
- Independent review found a narrow-layout ruler overlap; reserved a 32px gutter and added a geometry assertion.
- Packaging resource index matches the final verified build; installer generation is in progress.

- Preserve working tree changes, all session operations, keyboard focus visibility, light theme and narrow layouts.
- No new dependencies, persistence/API changes, fake tools, or interruption of running user applications.
- Generated release files remain ignored. Each independently verified change gets a Conventional Commit.

# Claude Project Visual Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline in the current session. Steps use checkbox syntax for tracking.

**Goal:** Align the real Tnega Project screen with the user-provided Claude Projects reference while preserving the existing Box, Session, and Project APIs.

**Architecture:** Keep `ProjectExperience` as the production route and refine its existing Overview, Library, Memory, and Thread panels. Keep the workbench shell, navigation, message stream, and persistence boundaries intact; use the reference's compact three-column hierarchy and only show detail on demand.

**Tech Stack:** React, TypeScript, Astryx components, CSS, Vitest, Vite.

**Spec:** `docs/frontend-visual-design.md` and `docs/research/2026-09-25-claude-projects-redesign.md`, calibrated against the Claude Projects screenshot and comments supplied in the conversation.

## Global Constraints

- Prefer existing Astryx components and existing Project API contracts.
- Keep the Project masthead to one compact line; do not add a large title hero, slogans, or statistics.
- Show child thread status with an accessible signal/breathing dot; keep thread rows compact and open details only when selected.
- Keep Memory collapsed to a one-line summary and reveal full text/actions on demand.
- Keep the Thread composer to a text field and send action; do not expose model or permission selectors there.
- Show `↩ N replies` under a user message only for agent replies with matching `causationId`.
- Preserve light/dark theme parity and reduced-motion behavior.
- Do not add tests for cosmetic declarations; retain behavior tests for message receipts and thread messaging.

---

### Task 1: Match Overview to the compact Threads rail

**Files:**
- Modify: `apps/web/src/project/SidePanels.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/projectExperience.test.ts`

**Interfaces:** Consume `ProjectView`, `threadBuckets`, `threadStateLabel`, and Astryx `StatusDot`/`Collapsible`; preserve `OverviewPanel({ view, onOpenThread })`.

- [x] Replace verbose grouped status headings with concise `Waiting on you`, `Working`, `Idle`, and `Resolved` buckets; keep empty buckets hidden and show each count inline.
- [x] Render each child row as one compact clickable line: pulsing/status dot plus a single-line thread name; remove the always-visible goal/detail subline.
- [x] Keep full execution details in the selected Thread panel, not duplicated in the overview list.
- [x] Keep the existing production Project tests; the accessible row name and send behavior remain stable.
- [x] Run `pnpm exec vitest run apps/web/src/projectExperience.test.ts apps/web/src/project/ThreadPanel.test.ts` — 2 files, 10 tests passed.

### Task 2: Refine Library, Memory, and Thread panel hierarchy

**Files:**
- Modify: `apps/web/src/project/SidePanels.tsx`
- Modify: `apps/web/src/project/ThreadPanel.tsx` only if the panel needs a source-level hierarchy adjustment
- Modify: `apps/web/src/styles.css`

**Interfaces:** Preserve the current API methods and the Thread `onSend(text)` callback.

- [x] Use compact section labels and low-contrast separators for Library items; clamp titles/URIs until the item is opened or inspected.
- [x] Keep Memory previews one line; when expanded, allow safe wrapping, then place version metadata and edit/delete controls beneath the text.
- [x] Preserve the Thread's simple textarea and send button, ensure the composer stays docked, and show send errors without clearing the draft.
- [x] Check narrow-width stacking and reduced-motion styles against the existing breakpoints.
- [x] Run the focused Project tests — 2 files, 10 tests passed.

### Task 3: Make the visual design document an implementation contract

**Files:**
- Modify: `docs/frontend-visual-design.md`

**Interfaces:** Document the real `ProjectExperience` route, user-reference layout, and browser review procedure; explicitly mark `/design.html?project` as a fixture preview, not product behavior.

- [x] Record the compact three-column reference, thread row density, selected-thread detail, and panel-content rules in the Project section.
- [x] Record review checkpoints for the actual `App.tsx` → `ProjectExperience` path and light/dark appearance.
- [x] Run `pnpm --filter @tnega/web build` — TypeScript and Vite build passed. Review `git diff` before committing the cohesive visual pass.

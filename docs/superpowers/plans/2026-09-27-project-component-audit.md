# Project Component-by-Component Claude Alignment Plan

> **For agentic workers:** Execute inline in this session, one independently reviewable component at a time. Steps use checkbox syntax for tracking.

**Goal:** Bring the production Project frontend into detailed visual alignment with the user-provided Claude Projects screenshot and the Tnega visual contract.

**Architecture:** Keep `App.tsx` → `ProjectExperience` as the production path and preserve Box, Session, and Project API semantics. Audit every visible Project surface against the screenshot, then update the smallest owning React component and its styles; commit each finished component separately.

**Tech Stack:** React, TypeScript, Astryx, CSS, Vitest, Vite.

**Spec:** `docs/frontend-visual-design.md`, `docs/research/2026-09-25-claude-projects-redesign.md`, `docs/superpowers/specs/2026-09-25-project-box-blackboard-design.md`, plus the Claude Projects screenshot and explicit annotations in the user conversation.

## Global Constraints

- The Project view is one continuing main conversation with a right-side Overview/Thread panel.
- Keep the existing workbench information architecture and the compact project row: icon and one-line name.
- Remove decorative project hero text, duplicated counts, oversized cards, and repeated thread descriptions.
- Use Astryx components where they cover the interaction; do not create a parallel component library.
- Thread status remains visible through accessible dots and reduced-motion-safe animation.
- Thread messages use a plain text area and send action, with no model or permission selectors.
- A user reply receipt appears only for an agent reply causally linked to that user message.
- Keep Memory previews summarized and expandable; preserve Memory edit/history APIs and Library search/API behavior.
- Keep light and dark appearances legible; only add behavior tests where behavior changes, not for CSS details.

---

### Component audit and work order

| Screenshot component | Production owner | Current evidence | Work |
| --- | --- | --- | --- |
| Three-column shell and utility rail | `WorkbenchShell.tsx`, `styles.css` | Main chat, left workspace navigation, and right utility rail already coexist. | Tune Project-only surface values and pane borders; preserve navigation/actions. |
| Project entry in left navigation | `WorkspaceSidebar.tsx` | `.project-row` is a 32px icon/name row, matching the annotation. | Verify only; avoid expanding the row. |
| Project masthead | `ProjectExperience.tsx` | One compact toolbar contains name, connection dot, and Overview/Library/Memory selectors. | Align spacing and hierarchy with the reference's one-line title/Overview control. |
| User/agent messages and reply receipt | `Transcript.tsx`, `ProjectExperience.tsx`, `styles.css` | User uses a large filled bubble; causal `↩ N replies` already works. | Flatten the user surface toward the reference and preserve its receipt. |
| Thread dispatch result | `ProjectExperience.tsx`, `styles.css` | Dispatch currently renders a large card, expanded plan, state text, and reply button. | Replace with a compact, accessible linked thread row; open the detailed Thread panel on click. |
| Main composer and activity footer | `ProjectExperience.tsx`, `ComposerFrame.tsx` | Composer contains main-agent model controls; footer duplicates active and total counts. | Keep the composer controls; remove the redundant count footer. |
| Overview Threads list | `SidePanels.tsx`, `styles.css` | Groups and dot/name rows are now compact; resolved is collapsed. | Compare typography, spacing, counts, and active state directly to the screenshot. |
| Selected Thread details | `ThreadPanel.tsx`, `styles.css` | State/goal/expect/latest are all expanded above an expanded Plan. | Put status in the header and collapse context details until requested. |
| Library | `SidePanels.tsx`, `styles.css` | Search, artifact/resource grouping, count, title, and one-line location are present. | Verify hierarchy and overflow with long item names/URIs. |
| Memory | `SidePanels.tsx`, `styles.css` | One-line summary expands to full text and edit/history controls. | Verify long text, expanded editing, and history remain readable. |
| Theme and responsive behavior | `theme.ts`, `styles.css` | Exact theme values are defined in the “色彩与材料” table of `docs/frontend-visual-design.md`. | Match each light/dark token to that table; inspect desktop plus narrow layout. |

### Task 1: Calibrate the Project surface and message rhythm

**Files:**
- Modify: `apps/web/src/workbench/theme.ts`
- Modify: `apps/web/src/styles.css`
- Verify: `/design.html?project` using the production `ProjectExperience` component

- [x] Match each surface, text, accent, border, and user-message token to the exact HEX values in `docs/frontend-visual-design.md`.
- [x] Keep light mode on the same semantic roles and check text/status contrast in both modes.
- [x] Flatten Project user message bubbles and preserve clear separation through spacing and receipt placement.
- [x] Review the actual three-column screenshot before committing this component group.

### Task 2: Rebuild the dispatch result and remove duplicated activity chrome

**Files:**
- Modify: `apps/web/src/project/ProjectExperience.tsx`
- Modify: `apps/web/src/styles.css`
- Retain: causal receipt behavior in `apps/web/src/projectExperience.test.ts`

- [x] Replace the expanded dispatch card with one compact thread link containing status, thread name, and a restrained reply count when applicable.
- [x] Remove the embedded plan from the main timeline card; keep full plan and session details inside the selected Thread view.
- [x] Remove the separate active/total footer beneath the main composer because the Overview already presents thread state.
- [x] Run the existing causal receipt and thread-opening behavior tests.

### Task 3: Simplify the selected Thread panel

**Files:**
- Modify: `apps/web/src/project/ThreadPanel.tsx`
- Modify: `apps/web/src/styles.css`
- Verify: `apps/web/src/project/ThreadPanel.test.ts`

- [x] Make the selected thread name and accessible status dot the panel header's primary content.
- [x] Put Goal, Expects, and Latest inside an initially collapsed Astryx `Collapsible` labelled `Thread context`.
- [x] Keep execution plan and Session transcript in the scroll region; keep the textarea and send action docked at the bottom.
- [x] Verify failed sends retain draft text and the Thread contains no model, permission, or attachment controls.

### Task 4: Component-by-component visual review and implementation contract

**Files:**
- Modify: `docs/frontend-visual-design.md`
- Update: this plan's checkboxes with observed results

- [x] Preserve the audit matrix above and record any visual exceptions with their owning component.
- [x] Inspect left navigation, masthead, message, dispatch, composer, Overview, Thread, Library, and Memory at the same viewport as the reference; Library and Memory retain their compact source-grouped rows and expandable memory details.
- [x] Inspect light mode and the current narrow-width breakpoint; the responsive layout retains stacked Project panes below 1000px.
- [x] Run `pnpm exec vitest run apps/web/src/projectExperience.test.ts apps/web/src/project/ThreadPanel.test.ts` and `pnpm --filter @tnega/web build` after the coordinated refactor.
- [x] Review staged paths and `git diff --check`, then commit each independent component group using Conventional Commits.

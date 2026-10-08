# Dense redesign: handoff

Date: 2026-10-08. Status: phases 1–2 shipped to `main` (pushed, not released); phase 3 and two follow-ups remain.

## The ask (owner's words, condensed)

> Design the visual effect of this agent project: clean, turn icons mini, support higher information density. This is a general change.
> Native window controls (– □ ×) sit top-right; the design must include the Project part; move the workspace down so the sidebar is organised by workspace.
> Stay self-built (no Astryx).

Taste notes: calm comes from deciding what not to show; outcomes first; title + status cards; results stay in threads (see `docs/project/projects-design.md` §1).

## Sources of truth

| What | Where |
| --- | --- |
| Design canvas (current vs proposed, Project room + Board, thread view, token table, icon set) | `docs/design/redesign.html` (open in a browser; Day/Night toggle) |
| Spec | `docs/design/tnega-design.md` §5.5 Density, §5.6 Sidebar by workspace |
| Project UX intent | `docs/project/projects-design.md`, `docs/superpowers/plans/2026-10-08-project-chat.md` |
| Tokens | `apps/web/src/styles/tokens.css` |
| Changelog | `CHANGELOG.md` → Unreleased → Features (two entries) |

## Done

### Phase 1 — `dd458bf` feat(web): tighten density with shared size tokens and mini icons
- New density tokens in `tokens.css`: `--header-h 32px` (= desktop `TITLE_BAR_HEIGHT`), `--toolbar-h 28`, `--control-lg 32`, `--control 26`, `--control-sm 22`, `--row-h 26`, `--icon 14`, `--icon-sm 12`. Radii 3/4/6/8/12. Sidebar 240px.
- ~60 hard-coded heights in `app.css`, `project.css`, `workbench.css` now use those tokens.
- Icon `size` props normalised: 14 default, 12 inline, 18 empty-state; avatars 18 (turn), 20 (room/thread/subagent/board card), 28 (Board header), 56 (project welcome, unchanged).
- `svg.lucide[stroke-width="2"]` → 1.75 globally (app.css, near `::selection`).
- Tool rows: no tinted tile behind the icon (`.tool-icon` is a bare glyph); tighter row padding.
- Session header is one line (`.conv-title-wrap` row: title · workspace). The title's −6px offset moved to `.conv-title-row` (it was truncating the title).
- Workbench tool tabs: icon only unless active (`workbench.css`), which also removed the project rail's horizontal scrollbar.
- Window-control clearance already existed: `lib/desktop-chrome.ts` `markWindowControls` + `.desktop-chrome .window-controls-header`.

### Phase 2 — `aacd4db` feat(web): organise the sidebar by workspace
- `components/Sidebar.tsx` rewritten: workspace tree. Each workspace is a collapsible group → projects first (FolderKanban glyph, accent colour) → sessions by recency (8 shown, rest + archived projects behind “N more”). Hover a workspace row: new project / new session / ⋯ (remove from list). Footer: settings · Add workspace · update · theme.
- Removed: workspace switcher card, Sessions/Projects segmented toggle (`.sidebar-modes`), `.new-session` row, old switcher CSS.
- Current workspace uses App's live `sessions`/`projects`; other expanded workspaces fetch via `api.sessions(path)` + `projectApi.list(path)` inside the sidebar; a workspace that stops being current has its cached copy dropped so it reloads. Collapse state: `localStorage['tnega.sidebar.collapsed']`.
- `App.tsx`: callbacks now take `(workspace, id)`; `enterWorkspace(path)` switches before `select()` / `openProject()`; `forkSession(path, id)`, `deleteSession(path, session): Promise<boolean>`; projects load in both modes (sidebar always shows them); `changeMode` removed. `mode` still drives the main view.
- Tests: `components/Sidebar.test.ts` (grouping/order, cross-workspace open, collapse persistence, archived behind “more”). E2E `apps/web/e2e/project-chat.mjs` no longer clicks the Sessions tab (opens sidebar via `complementary "Workspaces"`).

Verification at hand-off: 202 web unit tests pass; `pnpm --filter @tnega/web test:e2e` 16/16 and `test:e2e:models` 6/6 (both themes); `eslint apps/web` clean.

## Remaining work

### Phase 3 — Project screens polish (main item)
Upstream 0.4.18–0.4.20 (pulled today) changed the Project UI after the canvas was drawn: chat bubbles (`61f7c23`, `c329b07`), compact agent messaging / `ExchangePanel` (`e2a8bd1`), stop/interrupt controls (`1a87324`), steering (`6309191`), simplified project actions (`d921252`). **First reconcile the canvas (section 1b of `redesign.html`) with what now exists**, then ask the owner before larger layout changes.

Candidate changes, per the canvas:
- Thread cards in the room as one 30px line: shape avatar · title · status dot · current step · chevron (`components/project/ThreadCard.tsx`, `.thread-card*` in `project.css`).
- Board (`components/project/Board.tsx`): compact Today strip (weather avatar + 4 stats in one row), lane headers as small caps with a status dot + count, denser cards (title, one line, 3px progress bar `n/m`, artifact chips, footer `time · tokens`), Idle + Resolved folded into one line.
- Thread view (`ThreadPanel.tsx`): checklist first, then the thread's own short log, one-line composer (same height as the room's).
- Check `ExchangePanel.tsx`, `ThreadMessages.tsx`, `ChatRun.tsx` and the room bubbles for leftover large paddings/avatars; keep the bubble rules the e2e asserts (body 13px, user/agent 13.5px, plain session messages have no bubble background, short agent reply < 45px tall).
- Re-run both e2e suites; they screenshot to `apps/web/e2e/.artifacts/` (git-ignored) for visual review.

### Follow-ups
1. **Status dots in the sidebar.** `SessionSummary` has no live/waiting/error state, so rows show type glyphs (coding / work / fork) instead of the canvas's weather-coloured dots. Needs a server field (e.g. running / waiting-on-you / failed) on `GET /api/sessions` plus a project-level weather on `GET /api/projects`; then render `.dot` per the canvas. Ask before changing the API.
2. **Diffstat per session** (`+84 −12`, shown on hover in the canvas) also needs server data; optional.
3. **Optional comfortable density.** The canvas proposes `data-density="comfortable"` restoring the old values; only if the owner wants it.
4. `docs/design/tnega-design.md` §5.3 still says "窄于 520px 时工具标签只显示图标" — now tool tabs are icon-only unless active at any width (§5.5 says so); tidy the wording when touching that section.

## Gotchas

- **Typecheck:** `pnpm --filter @tnega/web typecheck` fails with 11 pre-existing errors in `packages/` (run-summary, undici `Headers`); they exist on a clean checkout. Filter: `npx tsc -p apps/web/tsconfig.json 2>&1 | grep "error TS" | grep -v packages/` should be empty.
- **Running the UI:** root `D:\claude-workspace\hello-claude\.claude\launch.json` → `fb-mock` (3997), `fb-api` (3082, `TNEGA_HOME=.work/fb/home`), `fb-web` (5176). A second test workspace `.work/fb/ws2` with one session was added to the fb home for cross-workspace testing. API calls need header `x-tnega-client: 1`.
- **Hidden preview pane:** real clicks don't land and rAF doesn't tick. Shim `window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16)`, click via JS, and `resize_window` 1280×800 (reset to `desktop` after). The pane may render `file://` pages as static snapshots: reopen with `preview_start {url}` after edits.
- **Colours:** only `tokens.css`; run `pnpm exec vitest run apps/web/src/styles/contrast.test.ts` if any colour changes (none did in phases 1–2).
- **Commits:** Conventional Commits ≤72 chars, one per independently reviewable phase, update CHANGELOG Unreleased in the same change (see `AGENTS.md`). Don't run `pnpm build` while `pnpm test` runs.
- **Windows:** never `cp -r` / `rm -rf` `node_modules` from Git Bash (pnpm junctions).

# Review instructions

tnega is an agent harness (TypeScript, pnpm workspace) with a React web UI,
an Electron desktop app and an Ink TUI. The project rules live in `AGENTS.md`
(Chinese) and, for anything a user sees, in `docs/design/tnega-design.md`.
There is no `CLAUDE.md`, so treat both files as the project's rules: a change
that breaks a "必须 / 不得" (must / must not) rule in either of them is a
finding.

## Pull requests run no CI

Pull requests get no lint, typecheck or test run. The full suite (including
Windows) only runs when a release tag is pushed, and one failing job there
blocks every installer. So do report what CI would normally catch: type
errors, a public type or export changed without updating its consumers,
tests that cannot pass, imports that cannot resolve, and lint-level problems
that hide a bug. The only exception is
`.github/workflows/desktop-packages.yml`, which packages the desktop app on
PRs that touch `apps/desktop/**`.

## What Important means here

Reserve Important for findings that would:

- break behaviour a user relies on, lose or corrupt Session / Project data,
  or make a replayed Session differ from the live one;
- weaken the sandbox or the workspace path fence, or make a high-privilege
  tool (shell, network) run without explicit opt-in;
- fail the release test gate, on Linux or on Windows;
- break a "must / must not" rule in `AGENTS.md` or the design guide.

Naming, refactoring ideas and style preferences are Nit at most.

## Cap the nits

Report at most five Nits per review.

## Always check

Feature and fix PRs:

- `CHANGELOG.md` is not edited. Only the release-prep PR (title
  `chore(release): ...`, which also bumps versions and adds
  `docs/releases/vX.md`) writes it, from the merged PR titles.
- `dist/` and other build output are not edited by hand or committed.
- Commit subjects follow Conventional Commits and stay under 72 characters.

Core invariants (`AGENTS.md`, "设计不变量"):

- Plugin registrations belong to their Fiber, and dispose undoes them in
  reverse order with no leftover services, listeners or child processes.
- Capability seams keep their direction: a Provider and a Consumer depend only
  on the Service Definition, never on each other, and a Consumer never imports
  or lists a concrete Provider. See `docs/adr/0006-capability-seams.md`.
- The sandbox only limits file writes and fails closed: with no working
  mechanism it throws `SANDBOX_UNAVAILABLE` and never falls back to
  unrestricted execution. `bypass` means "no sandbox", not a wider policy.
- The text of a tool result that reaches the model comes only from
  `renderToolResult` in `@tnega/session`. Flag any second `stringify` of tool
  results for the model, token counting or spill.
- The model-visible history can be rebuilt from durable Session events alone.
  Live `agent/*` events are for observing or intercepting, never the source of
  history.
- A tool records its call intent, then runs, then records its result. Paths
  stay inside the workspace.
- A change to a public type, event name, lifecycle or package export updates
  its direct consumers and the nearest behaviour test. A change to the root
  `package.json` `exports` also matches `scripts/build.mjs`.
- No `any`, type assertions or lint-disable comments used to get past an
  error.

Frontend (`apps/web`, the desktop renderer, `packages/tui`), from the design
guide:

- No raw colours, font sizes or control heights in components. Colours come
  only from `apps/web/src/styles/tokens.css`; sizes from `--text-*` and the
  density tokens. A colour change covers every palette in both light and dark.
- Reuse the existing components and classes listed in design guide §8
  (`.button` variants, `Menu`, `Dialog`, `confirmDialog`, `.notice`,
  `.empty-state`, `StatusLight`, ...) instead of a new visual style.
  `window.confirm` is a finding.
- New file, change, terminal, browser or document views go into the
  Workbench as a tool or document tab, not a new drawer.
- Weather keeps one meaning per weather (`apps/web/src/lib/weather.ts`). A
  new agent state reuses an existing weather; giving a weather a second
  meaning is a finding.
- Animation respects `prefers-reduced-motion`; durations use
  `--duration-fast` / `--duration-med`.
- Every interactive element is keyboard reachable, has a visible focus and a
  readable name. An icon-only button needs an `aria-label`. A button whose
  visible name is composed from several pieces (icon plus text, text split
  across elements, a count next to a label) also needs an `aria-label`:
  tests that find it by role and name have failed only on Windows, where the
  release gate runs.
- Mutually exclusive options use `role="radio"` with `aria-checked`.
- Icons are lucide only.
- A PR that changes a design rule updates `docs/design/tnega-design.md` in the
  same change.
- A new setting has a test that covers what happens after it is chosen.
- The TUI may use blue rain in the status-line weather; that is an allowed
  exception to the "no blue" default theme rule.

Cross-platform:

- New code that builds or compares paths uses `node:path` and does not assume
  `/` separators or case-sensitive file names. Tests that spawn or kill
  processes, or clean up temp folders, tolerate Windows (files can stay
  locked for a moment after a process is killed).

Desktop (`apps/desktop`):

- The renderer keeps context isolation and sandbox on and Node integration
  off; new IPC goes only through the validated bridge in `src/preload.ts`.
- Packaging config lives only in `electron-builder.yml`.

## Do not report

- `pnpm-lock.yaml`, anything under `dist/`, `apps/desktop/out/` and
  `apps/desktop/release*/`.
- Screenshots and other binary assets under `docs/`.
- Wording or translation choices in Chinese docs, unless the text is wrong
  about behaviour.
- These known test failures, which are not caused by the PR: two
  Windows-only sandbox path tests, and two bubblewrap (`bwrap`) sandbox tests
  that fail in cloud containers where bubblewrap cannot run.

## Evidence

- A claim about behaviour needs a `file:line` citation from the source, not an
  inference from a name.
- A claim that a test will fail on Windows names the line that depends on the
  platform.

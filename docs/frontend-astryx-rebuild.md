# Frontend rebuild with Astryx

## Product direction

Rebuild the existing Tnega frontend progressively with Astryx as the primary component library. Preserve the current workbench information architecture: workspace and session navigation on the left, the selected conversation or project in the main area, and an optional tools panel on the right.

## Implementation rules

- Work in this order: overall layout, local components, then full application integration.
- Prefer an existing Astryx component whenever it fits. Compose existing components when needed; leave a surface as-is and record why when Astryx has no suitable component. Do not create a replacement component just to avoid using the library.
- At each rebuilt surface, remove frontend tests that only assert the replaced presentation or obsolete implementation. Prefer deletion over adaptation when meaningful reuse is low. Keep tests for still-used state, event projection, API, persistence, and other behavior independent of the old presentation.
- Do not add tests for reversible, low-impact changes that merely restate the implementation. Run focused checks per phase and defer the full frontend/build verification until the global integration phase.
- Keep each independently reviewable phase in its own Conventional Commit, with no unrelated files.

## Existing frontend boundaries

- `apps/web/src/App.tsx` owns application state and assembles the active workbench view.
- `apps/web/src/workbench/WorkbenchShell.tsx` owns the top bar, workspace navigation frame, main content frame, and optional tool rail/panel.
- `apps/web/src/workbench/WorkspaceSidebar.tsx` owns workspace, project, session navigation and its local actions.
- `apps/web/src/conversation/ChatView.tsx` and `apps/web/src/project/ProjectExperience.tsx` own conversation and project experiences.
- `apps/web/src/styles.css` contains the current global tokens and layout/component styling.

## Astryx guidance

The app uses React 19, which meets Astryx's React 19+ requirement. Astryx documents matching primitives for this product, including App Shell, Side Nav, Chat Layout, Chat Composer, Chat Message, Chat Tool Calls, Dialog, Tab List, Text Input, Text Area, Button, and Icon Button. Verify exact exports and props through the installed Astryx CLI/docs before using them. Retain application-specific React components only where they own Tnega state or behavior that Astryx does not provide.

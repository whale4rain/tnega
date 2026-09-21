# Coding Workbench Implementation Plan

**Goal:** Replace the console layout with a coding-focused desktop workbench based on the supplied reference.

**Architecture:** Keep API, event projection and run lifecycle intact. Compose a shell, workspace navigation, conversation, composer and optional tools panel; use Radix Themes for interactive primitives and Tailwind for layout. Replace the old stylesheet rather than adding another override layer.

**Tech Stack:** React, TypeScript, Radix Themes, Lucide, Tailwind/Vite.

**Spec:** User reference: collapsible sidebar, quiet conversation typography, anchored input, icon-triggered right tools placeholders. Preserve desktop chrome and explicit permissions; no synchronization work.

## Implementation

- [x] Add dependencies and a reusable shell (`workbench/WorkbenchShell.tsx`) with persistent sidebar collapse and accessible tools toggles.
- [x] Replace workspace/session controls with `workbench/WorkspaceSidebar.tsx`: project selector, search, new coding/general session, Radix action menus and rename/add dialogs.
- [x] Compose input controls in `workbench/ComposerFrame.tsx`; preserve slash commands, streaming, stop, permission opt-ins and session mode.
- [x] Replace global CSS with design tokens and layout styles; readable 15px prose, 13px code, fluid centered content, responsive sidebars.
- [x] Verify shell interactions using DOM tests (collapse/restore, tools open/close); run existing web regression tests, typecheck, production build and desktop package.
- [x] Update README and commit independently verifiable deliverables using Conventional Commits.

## Acceptance

The application fills its window. Sidebar can collapse and restore at desktop/mobile widths. Right icons open named, explicitly unavailable tool panels and close with Escape. Navigation retains rename/fork/delete, search and workspace selection. Composer submits with Enter, keeps Shift+Enter and IME input, exposes permission state and stop. No fake model/branch/PR actions. Existing backend/session data formats remain unchanged.

## Validation results

Web and desktop regression tests: 34 passed; composer IME/draft tests: 2 passed. Root and Web typechecks and scoped Web ESLint passed. Production build passed. Hidden Electron fixture verification confirmed 15px prose, 264px navigation, visible composer, no horizontal overflow at desktop/mobile widths, sidebar toggle and tools panels. Windows packaging is finishing; outputs are ignored build artifacts.

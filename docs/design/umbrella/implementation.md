# Implementation map

Where each Umbrella component lives in `apps/web/src`, and its status. Update the status column in the same commit that changes the component.

Status: **done** means built to this spec; **partial** means the tokens and shapes are applied but the structure from the spec is not yet built; **to do** means it is not started.

| Component | Spec | Code | Classes | Status |
| --- | --- | --- | --- | --- |
| Tokens, tiers, type, radii | [foundations.md](foundations.md) | `styles/tokens.css`, `lib/display.ts` | `[data-palette="umbrella"]` | done |
| Pen marks | [hand-layer.md](hand-layer.md) | `components/PenMark.tsx`, `components/StatusLight.tsx` | `.pen-*`, `.status-light` | done |
| Underline, hatching, drawn arrow | [hand-layer.md](hand-layer.md) | `app.css` hand layer section | `.pen-underline`, `.pen-hatch`, `.pen-arrow` | partial |
| Ground and floating panels | [shell.md](shell.md) | `App.tsx`, `styles/app.css`, `styles/workbench.css` | `.app`, `.app > main`, `.workbench`, `--panel-gap` | done |
| Sidebar | [sidebar.md](sidebar.md) | `components/Sidebar.tsx` | `.sidebar-start`, `.sidebar-new`, `.sidebar-plus`, `.sidebar-search`, `.sidebar-group-head`, `.session-item`, `.sidebar-round` | done |
| Conversation header, Work pill | [conversation.md](conversation.md) | `components/Conversation.tsx`, `components/Composer.tsx` (`SessionControls`) | `.conv-header`, `.work-pill` | partial |
| Agent turn, disc, result cards | [conversation.md](conversation.md) | `components/Timeline.tsx` | `.turn`, `.turn-disc`, `.result-card` | done |
| Your message | [conversation.md](conversation.md) | `components/Timeline.tsx` | `.user-bubble` | done |
| Steps | [conversation.md](conversation.md) | `components/Timeline.tsx` (`ProcessHead`, `StepGroup`, `ToolRow`) | `.process-head`, `.tool-row` | done |
| Code, tables, quotes | [conversation.md](conversation.md) | `components/CodeBlock.tsx`, `components/Markdown.tsx` | `.code-block`, `.prose table` | done |
| Turn actions | [conversation.md](conversation.md) | `components/Timeline.tsx` (`IconAction`) | `.turn-actions` | done |
| Approval, secret input | [asks.md](asks.md) | `components/Conversation.tsx` (`ApprovalCard`) | `.approval-card` | partial |
| Question | [asks.md](asks.md) | `components/QuestionPanel.tsx` | `.question-*` | done |
| Plan | [asks.md](asks.md) | `components/Conversation.tsx` (plan panel) | `.plan-*` | done |
| Notices | [asks.md](asks.md) | `components/InstallNotice.tsx`, `components/ComputerHint.tsx`, `components/MxcHint.tsx`, `Timeline.tsx` (`Notice`) | `.notice-card` (the older `.notice` alerts in forms, `Conversation.tsx` status lines still to move) | partial |
| Composer | [composer.md](composer.md) | `components/PromptBox.tsx`, `components/Composer.tsx` | `.composer-*` | done |
| Work row, thread card | [work.md](work.md) | `components/WorkRow.tsx`, `components/project/ThreadCard.tsx` | `.work-row`, `.thread-card` | done |
| Board | [work.md](work.md) | `components/project/Board.tsx` | `.board-head`, `.board-group`, `.board-done` | done |
| Workbench tabs and cards | [work.md](work.md) | `components/workbench/Workbench.tsx` and views | `.wb-tab.pill`, `.wb-tab.round`, `.wb-card`, `.wb-list` | done |
| Buttons, fields, choices, chips | [controls.md](controls.md) | `styles/app.css`, `components/SettingsCard.tsx` (`Switch`), `components/ChoiceField.tsx` | `.button`, `.field`, `.switch`, `input[type=checkbox]`, `.settings-choice-row`, `.chip` | partial |
| Menus, tooltips | [controls.md](controls.md) | `components/Menu.tsx` | `.menu-popover`, `.menu-item`, `.menu-check` | partial |
| Dialog, confirm | [dialogs.md](dialogs.md) | `components/Dialog.tsx`, `components/ConfirmHost.tsx` | `.dialog`, `.dialog-confirm` | done |
| Settings | [dialogs.md](dialogs.md) | `components/SettingsDialog.tsx`, `components/SettingsCard.tsx` and settings parts | `.settings-*`, `.settings-card` | done |
| Welcome | [welcome-and-empty.md](welcome-and-empty.md) | `components/Welcome.tsx`, `lib/welcome.ts` | `.welcome-*`, `.welcome-starter` | done |
| Empty, loading, errors | [welcome-and-empty.md](welcome-and-empty.md) | `components/EmptyState.tsx` (`EmptyState`, `DrawnArrow`, `Loading`), workbench views | `.wb-empty`, `.pen-arrow`, `.wb-loading` | partial: Workbench and Board done; `.empty-state` elsewhere and error cards to do |
| Phone layout | [phone.md](phone.md) | `styles/app.css` `@media (max-width: 860px)` | | to do |
| TUI | `tnega-design.md` §5.8 | `packages/tui` | | separate PR (#102) |

## Rules while migrating

- Keep tests passing; tests that find buttons by role and name must keep working. A button whose visible name is composed from several pieces needs an `aria-label`.
- No raw colours or sizes in components: tokens only. New tokens go in `tokens.css` for every palette, light and dark.
- Remove what a spec says is removed (badges, spinners next to text, header bars on boxes) instead of hiding it with CSS.
- After each component: screenshot light and dark, and update the status above.

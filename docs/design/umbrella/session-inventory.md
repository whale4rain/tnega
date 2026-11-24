# Session screens: component inventory

The normal session experience (not Projects), split into the parts a person sees. This is the
list the 2026-11-24 polish pass worked through. Each part names its elevation (see
[foundations.md](foundations.md#elevation)) and what changed.

Elevation, in short: **e0** flat on its tier · **e1** a resting card (hairline + soft shadow) ·
**e2** a lifted control or card under the pointer · **e3** popovers · **e4** dialogs.

## Shell

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 1 | Window ground | `.app` | e0 | Stays the flat `--bg-sidebar` the panels float on. |
| 2 | Conversation panel | `.app > main` | e1 panel | Soft panel shadow so it floats off the ground instead of being a flat cut-out. |
| 3 | Workbench panel | `.workbench` | e1 panel | Same panel shadow as the conversation. |

## Sidebar

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 4 | Brand row | `.sidebar-top` | e0 | 48 tall, level with the header. |
| 5 | New session | `.sidebar-new` | e1, e2 on hover | White pill with a hairline and a small shadow; lifts on hover, settles when pressed. |
| 6 | More start actions (+) | `.sidebar-plus` | e0 | Quiet round button; tint on hover. |
| 7 | Search | `.sidebar-search` | e0, e1 while typing | Quiet row; turns into a white e1 field when focused. |
| 8 | Group label | `.sidebar-group-head`, `.workspace-toggle` | — | 12.5/600 `--text-3`. |
| 9 | Session row | `.session-item` | e0 | 36 tall, tint on hover. |
| 10 | Open session row | `.session-item.active` | e1 | White with the small card shadow, so the open row reads as picked up. |
| 11 | Row menu (…) | `.session-more` | e0 | Appears on hover or focus. |
| 12 | Footer: Settings + light/dark | `.sidebar-footer`, `.segmented` | e0 track, e1 thumb | The selected segment is a raised thumb with a small shadow. |

## Conversation header

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 13 | Title + folder chip | `.conv-title`, `.conv-folder` | e0 | Title truncates first; the folder chip hides when the header is narrow so it never overlaps the mode word. |
| 14 | Mode / Access words | `.word-choice` | e0 | Words with a caret; tint on hover. |
| 15 | Plan / jobs icons | `.conv-header-actions` | e0 | Round 32 targets. |
| 16 | Workbench pill | `.work-pill` | e0 closed, e1 open | Panel icon + "Workbench"; ink with a soft shadow while open. |
| 17 | More (…) | `.header-more` | e0 | Round 32. |

## Transcript

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 18 | Your message | `.user-bubble` | e0 sunken | One tone below the panel, ink text, padding 10 18. |
| 19 | Agent disc | `.turn-disc` | e0 | The brand cloud, aligned to the first line. |
| 20 | Step line (folded) | `.turn-process` | e0 | One quiet line: mark, plain words, time, chevron. |
| 21 | Step rows (open) | `.step-row` | e0 | Rows hang under the line with a hairline guide. |
| 22 | Prose | `.prose` | — | 15/24, headings 600, lists with breathing room. |
| 23 | Inline code | `.prose code` | — | Small sunken chip in mono. |
| 24 | Code block | `.code-block` | e1 inset | Code sits on `--code-bg` with a hairline, not a heavy grey slab. |
| 25 | Table | `.prose table` | e0 | Hairlines only. |
| 26 | Turn actions (copy, fork) | `.turn-actions` | e0 | Appear on hover; round and quiet. |
| 27 | Notice card | `.notice-card` | e1 | White card with the small shadow. |
| 28 | Approval card | `.approval-card` | e1 | White card, ink primary button. |
| 29 | Question panel | `.question-card` | e1 | White card; the chosen option has the ink ring. |
| 30 | Reply outputs (files, images, UI) | `.office-file`, `.reply-image`, `.a2ui-surface` | e1 | Cards share the small shadow; images get the hairline. |
| 31 | Changed-files card | `.changed-files` | e1 | Same card as the reply outputs. |
| 32 | Jump to latest | `.jump-button` | e3 | Round raised button with the popover shadow. |
| 33 | Day divider / load older | `.load-older` | — | Quiet `--text-3` line. |

## Composer

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 34 | Composer pill | `.composer-box` | e1, e2 while focused | The main object on the page: white, hairline, soft shadow that deepens while you type. |
| 35 | Attach (+) | `.composer-lead` button | e0 | Sunken round 40. |
| 36 | Model word | `.composer-trail` model picker | e0 | Word with a caret. |
| 37 | Send / stop | `.send-button` | e1 when ready | Ink round 40; disabled is sunken and flat. |
| 38 | Queued messages | `.queued` | e1 | Small cards over the composer. |
| 39 | Slash / @ menu | `.slash-menu` | e3 | Popover shadow. |

## Welcome

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 40 | Brand tile | `.welcome-mark` | e1 | Raised tile with the small shadow, not an outline. |
| 41 | Greeting | `.welcome-greeting` | — | Display 34/700. |
| 42 | Starters | `.welcome-starter` | e1, e2 on hover | White pills with a hairline and lift on hover. |
| 43 | Pick up where you left off | `.welcome-recent` | e0, e1 on hover | Rows lift to a white card on hover. |

## Overlays and controls

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 44 | Menu | `.menu-popover` | e3 | Hairline instead of a 1 px border, layered popover shadow. |
| 45 | Tooltip | `.tooltip` | e3 | Ink pill. |
| 46 | Dialog | `.dialog` | e4 | Layered dialog shadow over the scrim. |
| 47 | Settings dialog (nav + cards) | `.settings-*` | e4 shell, e1 cards | Cards inside get the hairline and small shadow. |
| 48 | Buttons | `.button` | primary e1, others e0 | Primary ink gets a small shadow; secondary and ghost stay flat. |
| 49 | Fields, selects, switches | `.field`, `select`, `.switch` | e0 sunken | Switch knob gets a small shadow. |

## Workbench

| # | Part | Where | Elevation | Polish |
| --- | --- | --- | --- | --- |
| 50 | Tab row | `.wb-tabs` | e0, open tab e1 | The open tab is a raised pill with the small shadow. |
| 51 | File tree | `.file-tree` | e0 | Rows 30 tall, tint on hover. |
| 52 | Reading card | `.wb-card` | e1 | Hairline + small shadow inside the Workbench frame. |
| 53 | Empty state | `.wb-empty`, `.empty-state` | e0 | The pen arrow and one line. |

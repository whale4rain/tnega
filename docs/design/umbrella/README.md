# Umbrella

Umbrella is tnega's design language, from 2026-11-22. This folder is the detailed spec: one file per area, with every component designed from what it is for, not recoloured from the old design.

`docs/design/tnega-design.md` is still the rulebook that `AGENTS.md` points to. Its §1–§3.9 hold the short version of Umbrella (tokens, shapes, the hand layer). This folder holds the long version: what each component shows, its anatomy, sizes, states, and why. When the two disagree, fix both in the same change.

The visual reference is the design canvas, boards 9 to 10c ("Scribble for real" and "Umbrella in tnega: every component, rethought").

## The idea in four sentences

1. **Two layers.** The *set layer* (layout, panels, cards, fields, buttons, type) is exact and flat. The *hand layer* is a pen marking it up: status marks, a loop around what needs you, an underline under two words, hatching inside progress.
2. **Tone, not lines.** Things are told apart by shades of grey: ground, then panel, then card. There are no outline borders. Raised shapes get a soft elevation step (a hairline ring and a wide, faint shadow) so panels float and cards rest on them; menus and dialogs get the deepest ones. See [foundations.md](foundations.md#elevation).
3. **One thing, one shape.** Nothing gets a frame inside a frame, and no box gets a header bar. A component is one shape: a pill, a rounded card, a sunken field or a round button.
4. **Whose turn is it?** Every list and every card answers this first. Anything waiting on you rises to the top, carries the *you* mark (a dot circled by hand), and is the only thing in full ink. Everything else steps back to the second grey.

## Files

| File | What it covers |
| --- | --- |
| [foundations.md](foundations.md) | Colour tiers, type ramp, spacing, radii, elevation, focus, motion |
| [hand-layer.md](hand-layer.md) | The pen: marks, sizes, loops, underlines, hatching, drawn arrows, where the pen may and may not go |
| [shell.md](shell.md) | Ground, floating panels, gaps, widths, folding, desktop title bar |
| [sidebar.md](sidebar.md) | Brand, New session, search, Your turn group, rows, footer |
| [conversation.md](conversation.md) | Header, agent turn, your message, steps, Markdown (code, tables, lists, quotes), turn actions |
| [asks.md](asks.md) | Approvals, questions, plans, notices, secret input |
| [composer.md](composer.md) | The composer pill: attach, model word, send/stop, queue, drop, slash menu |
| [work.md](work.md) | Work rows, thread cards, the Board, Workbench tabs and tools |
| [controls.md](controls.md) | Buttons, fields, switches, checkboxes, segmented, chips, menus, tooltips |
| [dialogs.md](dialogs.md) | Dialogs, confirmations, Settings |
| [welcome-and-empty.md](welcome-and-empty.md) | Welcome, empty states, loading, errors |
| [phone.md](phone.md) | Narrow windows and phones: sheets, targets, what changes and what doesn't |
| [session-inventory.md](session-inventory.md) | The session screens split into 53 parts, each with its elevation step and polish note |
| [implementation.md](implementation.md) | Where each component lives in code, the classes and tokens it uses, and the migration status |

## How to use this when you build

- Before touching a component, read its section here and the matching board on the canvas.
- Use tokens only (`apps/web/src/styles/tokens.css`). The hex values in these files are the **Umbrella light** values, given so you can picture them. Code always uses the token.
- New state? Map it to an existing pen mark (see [hand-layer.md](hand-layer.md)). Never add a coloured badge.
- New container? Ask which tier it is (ground, panel, card, raised, sunken) before you pick a colour.
- If you change a rule, change this folder and `tnega-design.md` in the same commit.

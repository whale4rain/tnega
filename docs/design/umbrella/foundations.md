# Foundations

Values are given as the token first, then the Umbrella light value, then the dark value. Components use tokens only.

## Colour tiers

Umbrella has five surface tiers. Every container must be exactly one tier, chosen by what it is, never by what looks nice next to its neighbour.

| Tier | Token | Light | Dark | What sits on it |
| --- | --- | --- | --- | --- |
| Ground | `--bg-sidebar` | `#ececec` | `#151516` | The window. The sidebar sits on it directly. Holds no content cards. |
| Panel | `--bg` | `#f7f7f7` | `#1b1b1d` | The conversation, the Workbench frame, reading surfaces in the Workbench. Radius 22. |
| Card | `--surface` | `#ffffff` | `#242426` | Results, work rows, settings sections, the open sidebar row. Radius 14–16. |
| Raised | `--surface-raised` | `#ffffff` | `#2b2b2d` | The composer, menus, dialogs, the selected tab, anything waiting on you. |
| Sunken | `--surface-sunken` | `#e8e8e8` | `#131314` | Fields, code, secondary buttons, unselected options, chips. |

Rules:

- **A child is always a different tier from its parent.** Card on panel, sunken inside card, raised on panel. Two neighbours on the same tier are separated by space, never by a line.
- **Hover** is `--surface-hover` (5% ink) and **pressed** is `--surface-active` (8.5% ink), laid over whatever tier the element is.
- **Selected** is `--accent-soft` (`#e0e0e0`) for rows and options. Where a selected item must be compared with its neighbours (palette cards, question options), it also gets a 1.5 px inset ink ring (`box-shadow: inset 0 0 0 1.5px var(--accent)`), never an outline.

## Ink

| Token | Light | Use |
| --- | --- | --- |
| `--text` | `#0e0e0e` | Reading text, titles, the one thing that needs you |
| `--text-2` | `#3a3a3c` | Secondary lines (what a thread is doing, descriptions) |
| `--text-3` | `#545457` | Meta: times, counts, hints. Still ≥ 4.5:1 on every tier |
| `--accent` | `#0e0e0e` | Ink fills: primary buttons, the send button, an open toggle, switches when on |
| `--text-inverse` | `#f7f7f7` | Text on ink |
| `--danger` | `#a62b25` | The only colour that is not grey: failure marks, delete confirmations, field errors |

There is no warning yellow, success green or accent blue in Umbrella's chrome. Success is a tick, waiting on you is the loop, both in ink. `--success`, `--warn` and the soft variants stay as tokens only for diffs, syntax and charts.

Contrast floors are enforced by `apps/web/src/styles/contrast.test.ts`: body text ≥ 7:1 on its surface, every text role ≥ 4.5:1 on every tier.

## Type

Geist for UI, Noto Sans SC for Chinese, JetBrains Mono for code. There is no serif. Display text is Geist 700 with −0.025em tracking (`--display-weight`, `--display-tracking`).

| Token | Size | Line | Use |
| --- | --- | --- | --- |
| `--text-xs` | 11.5 | 16 | Kickers, counts in chips |
| `--text-sm` | 12.5 | 18 | Meta, help text, times |
| `--text-md` | 13.5 | 20 | Controls, sidebar rows, menus |
| `--text-lg` | 15 | 24 | **Reading text**: messages, answers, asks |
| `--text-xl` | 19 | 26 | Panel titles (Work, Settings) |
| `--text-2xl` | 26 | 32 | Dialog and page titles |
| `--text-3xl` | 34 | 40 | The welcome greeting |

Weights: 400 body, 500 controls, 600 titles and the thing that needs you, 700 display. Nothing in all caps except a kicker (11.5, 700, +0.09em), and kickers appear only in design docs, not in the app.

## Spacing

A 4 px grid. The values that recur:

- **12**: the gap between the ground and a floating panel (`--panel-gap`), on every side.
- **6**: the inset inside the Workbench frame, so the cards inside are concentric (22 − 6 = 16).
- **12 / 28**: the gap between parts of a turn / between turns.
- **8**: between cards or work rows in a list. Rows never touch; 4 reads as one cramped block.
- **18–32**: between groups (sidebar sections 18, Board groups 32, the welcome page's recent list 48 below the starters).

**Breathing room (2026-11-24).** When a screen feels crowded, add space between groups before shrinking anything, and quiet the labels before the content: group labels are 12.5/600 `--text-3`, the rows under them carry the ink. Ink fills are for the one action inside a view (Send, Start, an open toggle); chrome around it (New session, your own message) stays a tone step, so a page has at most one or two dark shapes. Many black slabs read as cheap, not bold.
- **28**: the conversation's side padding at full width.
- **680**: the conversation column (`--reading-width`).

## Radii

`--radius-xs` 4 · `--radius-sm` 6 · `--radius-md` 10 · `--radius-lg` 14 · `--radius-xl` 16 · `--radius-2xl` 22 · `--radius-full`.

Nested radii are concentric: inner = outer − inset. Panels 22, cards 16 (14 for rows), fields 14, small rows and menu items 10, buttons and chips full, dialogs 28 (`--radius-2xl` + 6).

## Elevation

Changed 2026-11-24: a page with no shadows at all read as flat and cheap, so Umbrella now has a soft elevation scale on top of its tone steps. Every step is a 1 px hairline ring (5–8% ink; in dark mode 5–8% white) plus one or two soft, wide shadows. It gives a raised shape a visible edge without an outline border, and it never replaces the tone steps.

| Token | Use |
| --- | --- |
| `--shadow-xs` | Small raised controls: New session, the open session row, the selected segment, the open Workbench pill and tab, primary and send buttons, starters, file chips, the switch knob, Workbench cards. |
| `--shadow-sm` | Resting cards: the composer, notices, approval and question cards, result cards, settings cards, the welcome brand tile. |
| `--shadow-sm-hover` | Something under the pointer or being typed in: a hovered card or starter, the focused composer, a hovered New session. |
| `--shadow-panel` | The floating panels: the conversation and the Workbench frame. |
| `--shadow-md` | Menus, popovers, tooltips and the jump-to-latest button. |
| `--shadow-lg` | Dialogs and sheets. |

Still flat: the ground, rows in a list (until open or hovered), your message bubble, fields (sunken), chips and labels. Code blocks are inset: `--code-bg` with a 1 px `--code-border` ring. The shadows are defined once for light and once for dark in `tokens.css`, so every palette gets them. The list of which part gets which step is in [session-inventory.md](session-inventory.md).

## Focus

One ring everywhere: 2 px `--border-focus` (ink), offset 2, following the element's radius. No glow, no colour change instead of the ring. Fields get the ring on `:focus-visible` and also on `:focus` (typing needs to show where).

## Motion

`--duration-fast` 120 ms for hover and press, `--duration-med` 200 ms for fades, `--duration-panel` for panel folds, `--pen-draw` 380 ms for a mark drawing itself. Pressed buttons scale to 0.98. Everything respects `prefers-reduced-motion`: marks just appear and panels jump.

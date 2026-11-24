# The conversation

Everything in a turn hangs from one left edge, reads at 15 on 24, and is boxed only if it is a *result*.

## Header (44)

- Left: the title in 16/600, then the folder as a sunken chip (13, pill, padding 3 10).
- Right: **mode** and **access** as words with a caret ("Coding ⌄", "Read only ⌄"), because they are choices, not tools. Then the **Workbench** pill: the side-panel icon and the word "Workbench" (a bare "Work" did not say that it opens a panel), then "· N" files changed in `--text-3`, then the mark of the busiest state inside (`you` if anything waits on you, else `working`, else none). Sunken while the panel is closed, ink while it is open (`aria-pressed`). It toggles the Workbench. Then one round **…** holding everything else (plan, settings for this session, context, export).
- No row of bare icons whose meaning you have to hover to learn.

## Agent turn

```
(disc)  ✓ Read 3 files, ran the tests · 44 s ›        ← step line (14.5, --text-2)
        The answer, 16/24, --text.                    ← reading text
        ┌ result card (white, r16) ┐                  ← only results are boxed
```

- The **sliced brand cloud** (26) marks who is speaking, once per turn, top-aligned with the first line. Subagents use their own avatar.
- The parts of a turn are 12 apart; turns are 28 apart. The transcript starts 28 below the header and the composer sits 20 above the panel's foot.
- **Results** (changed files, a PR, an image, a created file, a subagent's report) are white cards, radius 16, padding 12 14: a 24 mark, a 600 title, meta in `--text-3`, and an action word at the right ("Review ›"). A diff preview inside uses a sunken mono block (radius 10).

## Your message

- Sunken bubble (`--surface-sunken`), `--text`, 16/24, padding 10 18, max 70% of the column, right-aligned. It was ink until 2026-11-24; a black slab per message outshouted the reply and made a long session look heavy, so your words now sit one tone below the panel and the reply stays the loudest thing on the page.
- Radius 20 20 6 20: the tucked corner points at you.
- Attachments sit above the bubble as image thumbs (radius 12) or file chips.
- Editing turns the bubble into the composer pill in place.

## Steps (tool calls)

Collapsed, a step group is one line:

- One mark for the group: `done` if all passed, `working` while any runs, `failed` (red) if any failed.
- The work in plain words ("Edited a file, ran a command"), then `· 44 s`, then a chevron.
- Failures are written, not badged: "· 2 of 3 failed" in `--danger` 500. **No coloured pill badges anywhere.**

Expanded, steps are rows directly on the panel (no frame), indented 24 under the line:

- Row: 14 mark, the verb (Read, Write, Shell, Search…) in a 90 px column, the target in mono, and the reason at the right if it failed (in `--danger`).
- The row you opened is `--surface-sunken`; opening it shows the full input and output in a sunken mono block.

## Markdown in answers

- **Headings**: h1 19/700, h2 17/700, h3 15/600. No rules under headings.
- **Lists**: 16/24, bullets in `--text-3`, 6 between items.
- **Inline code**: sunken, radius 6, 0.92em mono.
- **Code blocks**: one sunken shape (radius 14, padding 14 18). No border, no header bar. The language is a quiet label (12, `--text-3`) at the top right; a round copy button (32, `--bg`) appears on hover or focus, left of it. Long code scrolls inside.
- **Tables**: no outline and no filled header. Header row 600 `--text-2` with a `--border` hairline under it; body rows separated by lighter hairlines (`--border` at 60%); numbers right-aligned. Wide tables scroll inside their own box.
- **Quotes**: a 3 px `--border-strong` bar on the left, text in `--text-2`. The only left bar allowed.
- **Links**: ink, underline 1 px at 30% ink, full ink on hover.

## Turn actions

Copy, fork, retry and so on belong to the moment you reach for them. They are round 32 buttons (or a pill with a word for "Fork from here") under the turn, shown on hover or keyboard focus of the turn. On touch they are always shown.

## Day separators and times

"Today" is centred between two hairlines in 12.5 `--text-3`. Message times appear on hover only.

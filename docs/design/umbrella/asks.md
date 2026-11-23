# Asks, plans and notices

These are the moments the agent needs you, or needs to tell you something. They are where the hand layer is strongest.

## Approval

A white raised card (radius 16, padding 14 16), hanging from the agent's disc like any part of a turn.

1. Head row: the big `you` mark (28), then what and where in 13/500 `--text-2` ("Shell · in scratch/").
2. The ask in reading size, with the hand underline under the words that matter ("writes outside the sandbox").
3. The exact thing in a sunken mono block (command, path, URL).
4. Buttons: **Allow once** (ink), **Always for npm** (sunken), **Deny** (plain). The expected answer is ink. Keyboard: Enter allows once, Esc denies.

Removed: the shield icon, the yellow edge, the glow.

## Question

The same card family.

- Head: `you` mark (28) and the question in 15/600.
- Options are rows 48 tall, radius 14, sunken, with the `idle` mark; a description may follow in `--text-3`.
- The chosen option turns white, gets the 1.5 px inset ink ring and a small `done` tick in place of the ring mark.
- "Something else…" is the last option and opens a sunken text area in place.
- Buttons: **Answer** (ink), **Skip** (plain).

## Plan

A white card (radius 16) at the top of the transcript or in the Workbench.

- Title "Plan" 14.5/700 with "2 of 5" in `--text-3`.
- A hatched progress bar (8 tall, radius 4, sunken track, hatch fill) — the only kind of progress bar.
- Steps: 14 px rows, 8 apart, each with its mark: `done` (text steps back to `--text-2`), `working` for the step in hand (600), `idle` for the rest, `failed` if one failed.

## Notices

A notice says one thing and offers one way out.

- A white card one line tall (radius 16, padding 10 10 10 12): a 32 sunken disc with the subject's lucide icon, a sentence in 14, one sunken pill action, and a round close.
- Details (an install command, a log) open inside the same card on demand, in a sunken mono block, with an ink "Copy command".
- Notices sit above the transcript, inside the column width, never full-bleed.
- Severity is said in words. A failing notice uses the `failed` mark instead of the icon disc.

## Secret input

When the agent asks for a key: the approval card with a sunken password field (radius 14, mono) instead of the mono block, and **Save** (ink). The value never appears in the transcript; afterwards the card collapses to one line with a `done` mark: "Saved DEEPSEEK_API_KEY".

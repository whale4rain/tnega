# Welcome, empty states, loading and errors

## Welcome

The first screen should already say whose turn it is.

1. The umbrella on its disc, large (64).
2. The greeting on one line in 30–34/700 display: "Good afternoon. What are we building?" The second sentence is `--text-2`.
3. The composer pill, 620 wide.
4. Starters as sunken pills (34, 13.5): Map the codebase, Hunt a bug, Strengthen tests, Review recent work.
5. "Pick up where you left off": up to three rows (40, radius 12) with their pen mark, title and either "waiting on you" or when. A session waiting on you comes first, carries the `you` mark and is the only row in full ink; a running one has the `working` mark; the rest the `idle` ring (a session summary does not say whether its last run went well, so no tick).

Notices (such as the cua-driver hint) sit above the greeting as one-line notice cards ([asks.md](asks.md)), never as a grey slab.

## Empty states

An empty room is where the hand speaks.

- A small drawn arrow or loop (80×40, 2 px pen) pointing toward the action.
- One sentence in reading size (14–15, `--text-2`).
- At most one button, sunken.
- Centred in the card. No icons in circles, no grey small print.

Examples: "Pick a file to read it" (Files), "No changes since the last commit" (Changes), "Nothing waiting on you" (Your turn), "Start a terminal" (Terminal).

## Loading

- The `working` mark (28–36) with the hatch filling, and what is loading in words ("Reading the folder…").
- In lists: rows with a sunken bar where the title will be (skeletons), no spinner.
- Spinners next to text are removed.

## Errors

- A white card with the `failed` mark (30), what happened in one line ("DeepSeek didn't answer in 60 s."), and one sunken action ("Try again").
- In the transcript, a failed turn ends with a step line carrying the `failed` mark and the reason, then the action.
- Never a red text block or a red-bordered box.

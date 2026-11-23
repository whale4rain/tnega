# The hand layer

The hand layer is a person's pen marking up an exact page. It is what makes Umbrella feel like Umbrella, and it only works if the page under it is still. So the pen has strict rules.

Implementation: `apps/web/src/components/PenMark.tsx` (marks), plus the `.pen-underline`, `.pen-hatch` and `.pen-arrow` helpers in `app.css`.

## One pen

- One colour: `--pen` (= `--text`, ink in light mode, chalk in dark). The only exception is the *failed* cross, which is `--danger`.
- Line widths by size: 1.7 at 16–20 px, 2.6 at 28–40 px, 3.6 for a large tick.
- Strokes are slightly irregular paths, drawn once. They are not a wobble filter on the layout.

## The marks

Each mark has exactly one meaning. A new state must reuse one of these; it never gets a new mark or a colour.

| Kind | Drawing | Means | Where |
| --- | --- | --- | --- |
| `you` | A filled dot, circled by one open hand loop that overshoots | **Waiting on you.** The only mark that loops around something | Approvals, questions, Your turn rows, the sidebar Your turn group |
| `working` | A circle with a hatched wedge filling clockwise (solid half below 20 px) | Someone is on it; the wedge is progress when known, half when not | Steps running, threads working, plan step in hand |
| `waiting` | A dashed circle | Waiting on someone else (a person, a CI run, a schedule) | Waiting on others, queued messages, routines |
| `done` | A tick | Finished well | Done steps, merged PRs, finished threads |
| `failed` | A crossed X in `--danger` | Failed or refused | Failed steps, failed threads, errors |
| `idle` | A thin, faint ring | Nothing happening; not started | Plan steps not yet started, idle sessions |

Sizes: **16** in lists and lines (simplified strokes), **20** in work rows, **28** at the head of a card. Never scale a small mark up; each size is drawn for itself.

## What else the pen may draw

- **Underline** (`.pen-underline`): a hand stroke under at most two or three words that matter in a sentence, such as "needs you" or "writes outside the sandbox". At most one per card.
- **Hatching**: inside progress bars and inside the `working` mark. A hatched bar is the only progress bar.
- **Drawn arrows**: in empty states only, pointing at the one thing to do.
- **The logo**: lives on the layout layer (the Swiss geometric sliced cloud), not the hand layer.

## What the pen may never draw

- The outline of a card, button, field, panel or bubble. On a real phone, among real content, drawn edges turn the screen into a sketch and the one loop that matters is lost.
- Decoration. Every mark is the agent's note to you and must mean something.
- More than one loop per screen region. If two things need you, they are two rows in the Your turn group, each with a small `you` mark; the big loop belongs to the card you're looking at.

## Animation

A new mark draws itself once (`pen-draw`, 380 ms, stroke-dashoffset from 1 to 0). It never redraws on scroll, re-render or hover. With `prefers-reduced-motion` the mark simply appears. The `working` wedge moves only when progress changes; there is no spinning.

## Accessibility

A mark is never the only carrier of meaning: every mark has a label (as `aria-label` and tooltip) or sits next to text that says the same thing. Marks without a label are `aria-hidden`.

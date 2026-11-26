# Controls

Every control has one shape and no outline. Pills for things you press, sunken fields for things you type into, white for the one thing chosen.

## Buttons

| Kind | Fill | Text | Use |
| --- | --- | --- | --- |
| Primary | `--accent` (ink) | `--text-inverse` | The expected answer. One per card, dialog or area |
| Secondary | `--surface-sunken` | `--text` | The alternative |
| Plain | none | `--text` | A way out (Cancel, Skip, Deny) |
| Danger | `--danger` | white | Only inside a delete confirmation |

- Shape: pill. Height 34 (`.button`), 30 small, 40 large; 44 on touch. Padding 0 18. Text 14/600.
- Icon-only buttons are round (34, 30 small) and always have an `aria-label`.
- Hover: one tone darker. Pressed: `--surface-active` and `scale(0.98)`. Disabled: 40% opacity, no hover.
- Focus: the ink ring (2 px, offset 2).

## Fields

- Text inputs, selects and text areas: `--surface-sunken`, radius 14, height 36, padding 0 14, 14.5 text, **no border**.
- Label above (13/600), help below (12.5 `--text-3`). An error replaces the help with what to do, in `--danger`; the field itself gets no red border.
- Selects and one-line pickers are pills with a chevron.
- Search fields are white pills with a magnifier when they sit on the ground or a sunken tier, sunken pills when they sit on a card.
- Focus: the ink ring.

## Choices

- **Switch** for settings that act at once: 40×24 track, ink when on, `--border` grey when off; a white 18 knob.
- **Checkbox**: a sunken rounded square (20, radius 6); checked draws the `done` tick inside. No browser blue.
- **Segmented** (one of two to four): a sunken pill track (padding 3) with a white thumb; `role="radio"` with `aria-checked`.
- **Option list** (one of many): rows with a `done` tick on the chosen one, as in menus.

## Chips and counts

- A chip is a sunken pill, 12.5–13.5 text, padding 3 10. Chips are labels or filters, never status.
- Counts sit next to their label in `--text-3`, never inside a coloured bubble. The Workbench pill shows its count the same way, after a middle dot.

## Menus and popovers

- White (`--surface-raised`), radius 16, `--shadow-md` (its hairline ring is part of the shadow), 6 inset.
- Items 34 tall, radius 10, 14.5 text, an optional 15 lucide icon. The current item gets the `done` tick. Hover is `--surface-hover`.
- Destructive items sit last after one separator, in `--danger`.
- Keyboard: arrows move, Enter picks, Esc closes and returns focus.

## Tooltips

An ink pill (`--accent` fill, `--text-inverse`, 12.5, padding 6 10). Shown after 500 ms hover or on focus. Shortcuts appear after a middle dot: "Open the Workbench · Ctrl J".

## Icons

lucide only, stroke 1.8, sizes 14/15/16/18. Icons are never status; status is a pen mark.

# Dialogs and Settings

## Dialog

- A white sheet (`--surface-raised`), radius 28, `--shadow-lg`. The scrim is `--scrim`.
- Title in 20–26/700 display, top left. Close is a round button top right.
- Body text 14–15. Buttons bottom right: plain *Cancel*, then the ink answer.
- Width: 440 for a confirmation, 560 for a form, 760–880 for Settings.
- Opens with a 200 ms fade and a 0.98 → 1 scale; reduced motion just shows it.

## Confirmation

`confirmDialog` only (never `window.confirm`). Title says the act ("Delete this project?"), one sentence says what is lost, then *Cancel* (plain) and the act (danger fill for deletes, ink for everything else).

## Settings

A dialog with two columns.

- **Left nav** (200): "Settings" in 20/700, then pills 34 tall, one per section; the open one is sunken and 600. Each pill may have its 15 lucide icon.
- **Right side**: the panel tone (`--bg`). Each section is a set of **white cards** (radius 16, padding 16), one per decision: a 15/700 title, one sentence in 13 `--text-2`, then the control.
  - A single on/off decision puts the switch on the card's right, on the title row.
  - A list (models, secrets, routes) is sunken rows (48, radius 14) inside the card, with the default marked in words ("Default"), not a coloured badge.
  - A group of numbers is a two-column grid of fields inside one card.
- **Save** lives in a footer that appears only when something changed: *Cancel* (plain) and *Save changes* (ink). Leaving with unsaved changes asks once.

This replaces the old long page of label + bordered field pairs: a section now reads as a few decisions.

## Appearance section

- Theme: segmented Light · Dark · System.
- Palette: cards in a grid, each showing its ground, panel and ink; the chosen one gets the inset ink ring. Umbrella is first and default.
- Density, text size and reading width: segmented controls with a live preview line under them.

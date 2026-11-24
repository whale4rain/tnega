# Phones and narrow windows

Below 860 px the layout changes; the components do not.

## Layout

- **Chat is the whole screen.** The conversation panel loses its side gaps and fills the width under a 52 header; its top corners stay rounded (26) against the ground, its bottom runs to the screen edge.
- **Sidebar** becomes a sheet from the left (86% wide, max 300), over a scrim, with `--shadow-lg`.
- **Workbench** becomes a sheet from the bottom: radius 28 on top (concentric with the phone's corners), a 40×5 grab handle, and the same tabs. It opens from the header's Workbench pill.
- The header keeps three things: the sidebar button, the title, the Workbench pill.

## Targets

Every target is at least 44. Buttons become 44 tall; work rows stay 56; menu items become 44; round buttons become 44.

## Composer

The same pill above the keyboard, with safe-area padding. Attach and send are 40.

## What does not change

Pen marks keep their sizes. Tone tiers, radii of cards and the rules about borders and shadows are the same. There is no separate phone design language.

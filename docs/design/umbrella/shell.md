# The shell

## Anatomy (desktop)

```
┌ ground (--bg-sidebar) ──────────────────────────────────────────────────┐
│ sidebar          ┌ conversation panel (--bg, r22) ┐ ┌ Workbench (--bg) ┐ │
│ (on the ground,  │ header                          │ │ tabs              │ │
│  no panel)       │ transcript (680 column)         │ │ ┌ card (white) ┐ │ │
│                  │ composer pill                   │ │ └──────────────┘ │ │
│                  └─────────────────────────────────┘ └───────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
        10 px gap on every side of each panel (--panel-gap)
```

- **The window is the ground.** `.app` paints `--bg-sidebar`. Nothing but the sidebar's own rows sit directly on it.
- **The conversation is a floating panel**: `--bg`, radius 22 (`--radius-2xl`), margin `--panel-gap` on top, bottom and right, and on the left too when the sidebar is folded. It clips its content to the radius.
- **The Workbench is the second floating panel**: the same tone, radius and gap. Its frame (`.wb-frame`) holds tabs at the top and white cards inside with a 6 px inset.
- The two panels are equal partners: same tone, same radius, same gap. There is no divider between them; the ground showing through the gap is the divide.

## Why

The old shell had three different edges: a full-height sidebar, a conversation flush against it, and a bordered Workbench card. Umbrella gives every region exactly one shape and lets the ground do the separating, the same way the phone's own sheets float.

## Widths

- Sidebar: `--sidebar-width` (264).
- Conversation column: 680 (`--reading-width`), centred in its panel.
- Workbench: default `--workbench-default`, at most half the window.

## Folding

The sidebar and Workbench fold by animating the grid columns (`panels-moving`). The panels keep their shape while folding; only the space between changes. Reduced motion: they jump.

## Desktop title bar

- **macOS (`window-controls-left`)**: traffic lights sit at the top-left inside the 44 px sidebar brand row (`TRAFFIC_LIGHTS` centred vertically). Both the conversation panel and the Workbench keep their 10 px top gap, 22 px top corners and full 44 px header height, matching the Web layout; dragging works on the sidebar brand row and panel headers.
- **Windows and Linux**: the top 32 px hosts the native right-side window controls (`– ☐ ✕`). The main panel meets the top edge under the controls, and when the Workbench is open its top 32 px strip holds the conversation header actions beside the controls.

## Narrow windows

Below 860 px the sidebar becomes a sheet from the left and the panels lose their side gaps. See [phone.md](phone.md).

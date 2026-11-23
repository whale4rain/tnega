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

On the desktop app the top 32 px of each panel hosts the native window controls on the right. The header lives inside the panel, so the window controls sit on the panel's tone. The ground above the panels is the drag region.

## Narrow windows

Below 860 px the sidebar becomes a sheet from the left and the panels lose their side gaps. See [phone.md](phone.md).

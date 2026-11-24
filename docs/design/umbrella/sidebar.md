# Sidebar

The sidebar is where you **switch** what you are talking about. It sits on the ground with no panel of its own.

## Anatomy, top to bottom

1. **Brand row** (44): the sliced brand cloud (24), "tnega" in 16/700, the fold button (round, 34) at the right.
2. **Start row**: one white pill **New session** (34, fills the width, 500) and a quiet round **+** (34, no fill until hover) beside it. It is the one white shape at the top of the ground; ink stays for the action inside a view. The + opens a menu with *New project*, *Temporary chat* and *Open a folder…* (adding a workspace, which used to be a footer button). One obvious way to start, the rest one click away.
3. **Search**: a quiet row (34), magnifier, "Search", and the shortcut in mono at the right. Hover tints it; while you type it turns white with the ink ring.
4. **Your turn** group (only when something waits on you): sessions and projects whose agent is waiting on you, each with the `you` mark, title in 600, and how long it has waited. This group is always first, and a row in it leaves its own group, so each session or project appears once.
5. **Pinned**, then one group per folder.
6. **Footer**: round Settings (34) at left; a two-way segmented pill for light and dark at right. "System" moves into Settings › Appearance.

## Rows

- 34 tall, radius 12, padding 0 10, title 14.5.
- Pen mark (16), then the title in 13.5/400. Nothing else on the row; the menu button appears on hover or focus. A project row's mark is its status when a thread waits, fails or works, its project icon otherwise; a project with pull requests keeps the small pull request mark at the end.
- The open row is white (`--surface`) and its title is 500 in `--text`.
- The sidebar has 12 of padding and 10 between its parts; sections are 18 apart.
- Hover: `--surface-hover`. Waiting on you: title 600 and the `you` mark.
- Group headers (Your turn, Pinned, folders): quiet labels, 12.5/600 `--text-3`, with the count in 400. No all-caps. The rows carry the ink.

## Session marks

| Session state | Mark |
| --- | --- |
| Waiting on your approval or answer | `you` |
| Running | `working` |
| Queued / scheduled | `waiting` |
| Last run finished | `done` |
| Last run failed | `failed` |
| Never run, or read | `idle` |

## Removed

- The three equal text links at the top (New session, New project, Temporary chat).
- The grey search box with a border.
- The three-way theme switch in the footer.

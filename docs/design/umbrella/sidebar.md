# Sidebar

The sidebar is where you **switch** what you are talking about. It sits on the ground with no panel of its own.

## Anatomy, top to bottom

1. **Brand row** (44): the sliced brand cloud (24), "tnega" in 16/700, the fold button (round, 34) at the right.
2. **Start row**: one ink pill **New session** (38, fills the width) and a round sunken **+** (38) beside it. The + opens a menu with *New project*, *Temporary chat* and *Open a folder…* (adding a workspace, which used to be a footer button). One obvious way to start, the rest one click away.
3. **Search**: a white pill (36), magnifier, "Search", and the shortcut in mono at the right. Focus raises nothing; it just shows the ink ring.
4. **Your turn** group (only when something waits on you): sessions and projects whose agent is waiting on you, each with the `you` mark, title in 600, and how long it has waited. This group is always first, and a row in it leaves its own group, so each session or project appears once.
5. **Pinned**, then one group per folder.
6. **Footer**: round Settings (34) at left; a two-way segmented pill for light and dark at right. "System" moves into Settings › Appearance.

## Rows

- 36 tall, radius 12, padding 0 10.
- Pen mark (16), then the title in 13.5/400. Nothing else on the row; the menu button appears on hover or focus. A project row's mark is its status when a thread waits, fails or works, its project icon otherwise; a project with pull requests keeps the small pull request mark at the end.
- The open row is white (`--surface`) and its title is 600.
- Hover: `--surface-hover`. Waiting on you: title 600 and the `you` mark.
- Group headers: 12.5/700 `--text`, with the count in 400 `--text-3`. No all-caps.

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

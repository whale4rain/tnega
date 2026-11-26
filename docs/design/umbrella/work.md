# Work

Talk is a line; work is a set. This file covers everything that shows a piece of work: the work row, thread cards in the conversation, the Board, and the Workbench.

## The work row

The one component for "a piece of work". It appears in the conversation (as a thread card), on the Board, in the sidebar's Your turn group, and in the Workbench.

```
 (mark 20)  Title, 14.5/500 (600 if it's your turn)          2 h
            What it is doing now, 13 --text-2
```

- Min height 60, padding 10 14, radius 14, gap 12. Rows in a list are 8 apart.
- The mark says the state (see [hand-layer.md](hand-layer.md)). It appears **once**. The old card that showed a status light *and* an icon with "Done" is gone.
- The second line is the current step while working, the question while waiting on you, the result when done, the reason when failed (in `--danger`).
- The time is right-aligned, 12 `--text-3`: how long it has waited on you, when it is due, or when it finished.
- **Your turn**: white row, title 600. **On it**: the row currently selected is sunken; others are flat on the panel. **Done/failed**: flat.

## Thread card in the conversation

A work row inside a white card (padding 4, radius 16, width 330–460), at the point in the conversation where the work was handed off. Clicking opens the thread in the Workbench; the card that is open gets `--accent-soft`. "Reply in this thread" is a round button that appears on hover at the card's right.

## The Board

The Board answers "what needs me, what is moving", in that order.

1. Title: the project name in 22/700, then "6 going" in `--text-3`. Groups are 32 apart; their headers are quiet 12.5/600 `--text-3` labels, as in the sidebar.
2. **Your turn** (count): white work rows with the `you` mark.
3. **On it** (count): flat work rows with the `working` mark.
4. **Waiting on others** (count): flat rows with the `waiting` mark.
5. One line: `done` mark, "7 done today". It opens the history, which lists finished threads as flat rows grouped by day.

Which group a thread is in: waiting on you, blocked, failed, or a result you have not opened yet → Your turn; running → On it; idle (paused until another agent, a message or a schedule moves it) → Waiting on others; finished and read, or resolved → done. "N going" counts everything not finished. Stop, Resolve and Reopen are round buttons that appear on a row's hover, over the time.

Removed from the Board: step-segment bars, artifact chips, token counts and active minutes. Those live in the thread itself. The Board is not a dashboard.

## Workbench

The Workbench is a panel (see [shell.md](shell.md)) with tabs on top and white cards inside.

### Tabs

- A row 40 tall (`--tabs-h`). Tools you use often are **pills with a word** (Work, which the code still calls Board, Files, Changes); tools you use less are round icon buttons (Library, Routines, Terminal, Browser, Context). A count is a plain number beside the word in `--text-3`, never a coloured badge; a project tab with something waiting on you shows the `you` mark in place of its icon.
- The open tab is a white pill (`--surface-raised`), 600. Others are plain, `--text-2`, with `--surface-hover` on hover.
- Document tabs (a file preview, a thread, a subagent) follow a thin vertical rule, as pills with a close ×.
- On the desktop app the top row is the title bar; tabs sit under it.

### Toolbar row

Under the tabs: context on the left (path, branch, thread title in 15/600), actions on the right as round icon buttons or pills with words. No background of its own.

### Cards

- One white card per view (radius 16), filling the panel with the 6 px inset.
- **Files**: the tree is a column inside the card on `--bg` tone (not a separate bordered pane): rows 30, radius 10, file icon + name, the open file sunken and 600. The editor fills the rest.
- **Changes**: the same split; status letters in the diff colours; the diff itself uses only `--success-soft` / `--danger-soft` row tints.
- **Terminal** and **code** keep a `--border` hairline, because they are exact content on a near-identical tone.
- **Thread and exchange views** are reading surfaces: they use the panel tone directly (`.wb-flow`), no card, the same as the conversation.

### Empty tools

See [welcome-and-empty.md](welcome-and-empty.md): a drawn arrow toward the thing to do and one sentence in reading size, never grey small print.

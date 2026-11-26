# Composer

One white pill that grows only when you write more.

## Anatomy

```
( + )  Reply, / for commands, @ for files          DeepSeek ⌄  (●↑)
```

- The shell: `--surface-raised`, radius 24, min-height 48, padding 6 6 6 8, no border, `--shadow-sm` at rest and `--shadow-sm-hover` while focused, no focus ring of its own (the caret is the focus).
- **Attach**: a round 36 button with + on the left. It opens a menu: *Files*, *Images*, *Paste from clipboard*.
- **Field**: 16/24, grows up to 40% of the panel height, then scrolls. Placeholder says what Enter does right now ("Reply…", "Queue a message").
- **Model word**: the model's short name with a caret, 13 `--text-2`. Its menu holds the model, effort, and mode. The old separate effort dropdown and mode buttons fold into it.
- **Send**: a round 36 ink button with an up arrow. While the agent works it becomes **stop** (an ink circle with a white rounded square). If you have typed while it works, it stays send and a hint "Enter queues it" appears to its left.

## States

- **Multi-line**: the buttons stay on the first line's baseline at the bottom; attach and send align to the last line.
- **Dropping a file**: a dashed 2 px ink outline inside the pill (radius 22) and the placeholder changes to "Drop to attach". The only dashed line in the app.
- **Attachments**: thumbs (56, radius 12) or file chips above the text, inside the pill.
- **Slash or @ menu**: a menu (see [controls.md](controls.md)) that rises from the pill's top edge, aligned to its left inset.
- **Queued messages**: rows above the composer, each a sunken pill with the `waiting` mark, the text, and a round "send now" and "remove".
- **Disabled** (no model): the pill stays, the field says what to do ("Add a model in Settings to start"), send is a sunken round button.

## Where it appears

The same pill on the welcome screen, in sessions, in Project threads, and in the Temporary chat. Only the placeholder changes.

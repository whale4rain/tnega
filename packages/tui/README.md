# @tnega/tui

`tnega tui`: the terminal client. It starts the tnega server in the same
process on a free loopback port (or attaches to one with `--url`) and talks to
it through `@tnega/client`, exactly as the web app does, so sessions started
here open in the web app and the desktop app too. Projects are not part of the
TUI; `/web` opens the web app for them and for anything a terminal cannot show
(the browser screencast, image and Office previews, model route editing).

Built with [Ink](https://github.com/vadimdemedes/ink). Layout and colours follow
`docs/design/tnega-design.md` §5.8.

## Keys

| Key | Does |
| --- | --- |
| Enter | Send; while the agent runs, queue the text for after this run (↑ takes it back, Ctrl+X drops it) |
| Shift+Enter, Alt+Enter, Ctrl+J, trailing `\` | New line |
| Tab, Alt+Enter (while it runs) | Steer the agent with the text now; on an empty prompt, with what is queued |
| Shift+Tab | Mode: auto → plan → goal |
| ? (empty prompt) | Every key |
| Esc | Stop the run; close a panel |
| Ctrl+O | Show every step of the transcript, or fold it again |
| ↑ ↓ | Earlier prompts (on the first or last line) |
| Ctrl+A / Ctrl+E, Ctrl+U / Ctrl+K, Ctrl+W | Line start / end, delete to start / end, delete word |
| Ctrl+C | Clear the prompt; twice to quit (Ctrl+D on an empty prompt also quits) |
| y / n | Allow or deny a tool approval |

## Commands

The shared ones (`/plan`, `/goal`, `/auto`, `/model`, `/compact`, `/codemode`,
`/rename`) behave as in the web app, and a coding session adds its own skills
and MCP commands. The TUI adds `/new`, `/sessions`, `/continue`, `/usage`,
`/diff`, `/settings`, `/web`, `/help` and `/quit`.

## Code

- `controller.ts`: state and actions without Ink (streaming, steering,
  approvals, questions, recovery), following the web `Conversation`.
- `app.tsx`: layout. Finished entries go to the scrollback once through
  `<Static>`; only the running turn, prompts, composer and status line redraw.
- `composer.tsx` + `editor.ts`: the multi-line input, edited by grapheme and
  measured in terminal cells so Chinese text wraps and the IME follows the
  cursor.
- `transcript.tsx`, `markdown.tsx`: entries and Markdown as Ink elements.
- `views.tsx`, `picker.tsx`, `prompts.tsx`: panels, lists, approvals, questions.
- `hints.tsx`, `terminal.ts`: the key hint row, the `?` key sheet, and the kitty keyboard check.
- `weather.tsx`: the brand cloud at the top of a session and the coloured weather strip in the status line.

The row under the prompt names the keys that matter right now (`hints.tsx`).
Shift+Enter only works where the terminal speaks the kitty keyboard protocol;
the TUI asks once at start (`terminal.ts`) and names Ctrl+J instead elsewhere.

`TNEGA_REDUCED_MOTION=1` stills the spinners and the weather strip.

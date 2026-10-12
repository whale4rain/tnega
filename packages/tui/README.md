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
| Enter | Send; while the agent runs, the text steers it |
| Shift+Enter, Alt+Enter, Ctrl+J, trailing `\` | New line |
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

`TNEGA_REDUCED_MOTION=1` stills the spinners.

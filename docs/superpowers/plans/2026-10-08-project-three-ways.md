# Projects: token cost, interaction flow, UX

Date: 2026-10-08. Status: shipped on `claude/project-thread-p1x0jb` (PR #3).
Continues `2026-10-08-dense-redesign-handoff.md`; its phase 3 is done here,
its follow-ups 1–3 (sidebar status dots, diffstat, comfortable density) are
still open.

## How it was measured

A real DeepSeek (`deepseek-v4-flash`) Project on an empty repo, one request:
"Add count.mjs that prints the word count of a file, a node:test test, and
README usage." Driven through the HTTP API (`POST /api/projects/:id/messages`,
then `GET /api/projects/:id/usage`).

| | Before | After |
| --- | ---: | ---: |
| Model responses | 21 | 11 |
| Prompt tokens | 235k | 89–100k |
| Completion tokens | 16.9k | 6–8k |
| Wall time | 150 s | 43–58 s |
| Room messages after the user's | dispatch card + 3 coordinator bubbles + extra dispatch card | dispatch receipt + one line |

## What changed and why

1. **Tools per role** (`packages/cli/src/project-tool-scope.ts`). The
   coordinator explored with shell, polled threads and re-read their files.
   Now it has no shell/write/jobs/checklist tools (hidden from requests and
   refused by a guard); threads lose routine tools; `spawn_thread` is hidden
   at the depth limit; `echo`/`calculator`/`json` are not mounted.
2. **Bounded reports.** Quiet `complete` reports enter the coordinator's
   context cut to ~1200 characters at a paragraph boundary, with a pointer to
   `list_threads` `thread_id`, which returns the full text.
3. **No polling, explicit wake.** `list_threads` no longer advertises
   `wait_ms`. `spawn_thread` `on_report` names the coordinator's next step;
   only then does the report start a coordinator turn (and the step is shown
   with the report). A boolean flag was tried first: DeepSeek set it on every
   spawn, so the field asks for a concrete step instead.
4. **Approvals.** The automatic reviewer had `maxTokens: 512`; DeepSeek spent
   ~1.8k reasoning tokens per review, so every review ended at `length` and
   escalated to the coordinator (one full coordinator turn each). Now 4096
   and fenced JSON is accepted.
5. **Room noise.** A coordinator turn started only by threads, in which it
   settled the ask with `decide_thread_approval` or `send_thread_message`, is
   not published to the room. Dispatching to a thread that is still working
   stays in that thread. `send_project_message` refuses > 600 characters.
   Long coordinator messages fold in the UI.
6. **Live step.** Threads often skip `update_checklist`; a new `activity`
   stream event names the latest tool step ("Running node --test") on cards
   and the Board.

## Still open

- DeepSeek still writes long coordinator answers when it decides defaults for
  the user; the room folds them, the prompt asks for one line.
- Long-lived threads that get re-dispatched grow their context (2M cumulative
  prompt tokens over 60 responses in one test, 97% cached). Compaction or a
  fresh thread per unrelated follow-up would cut it.
- Sidebar status dots need a state field on `GET /api/sessions` / `GET
  /api/projects` (handoff follow-up 1).
- In this cloud container Node's `fetch` ignores `HTTPS_PROXY`; local runs
  used `NODE_USE_ENV_PROXY=1` and a config with
  `baseUrl: https://api.deepseek.com/v1`.

# Changelog

User-visible changes reconstructed from Git tags and commit history. Dates are
the tag commits' recorded dates. Version sections describe what shipped at that
point; historical capabilities may have since been removed. There are no Git
tags for 0.2.0, 0.4.3 or 0.4.4. Their development changes are included in the
next actual tag's range; missing tags alone do not prove no package was published.

## Audited history boundaries

Each release covers all commits reachable from its tag but not the preceding
actual tag, including merged branches. Entries summarize user-visible changes
and compatibility, rather than repeat every commit. Update Unreleased as each
feature or fix lands, and move entries into a version only when it ships.

| Version | Audited range | Commits |
| --- | --- | ---: |
| 0.4.12 | [`v0.4.11...v0.4.12`](https://github.com/whale4rain/tnega/compare/v0.4.11...v0.4.12) | 35 |
| 0.4.11 | [`v0.4.10...v0.4.11`](https://github.com/whale4rain/tnega/compare/v0.4.10...v0.4.11) | 5 |
| 0.4.10 | [`v0.4.9...v0.4.10`](https://github.com/whale4rain/tnega/compare/v0.4.9...v0.4.10) | 9 |
| 0.4.9 | [`v0.4.8...v0.4.9`](https://github.com/whale4rain/tnega/compare/v0.4.8...v0.4.9) | 7 |
| 0.1.1 | Repository start through `v0.1.1` | 93 |
| 0.3.0 | [`v0.1.1...v0.3.0`](https://github.com/whale4rain/tnega/compare/v0.1.1...v0.3.0) | 159 |
| 0.4.0 | [`v0.3.0...v0.4.0`](https://github.com/whale4rain/tnega/compare/v0.3.0...v0.4.0) | 55 |
| 0.4.1 | [`v0.4.0...v0.4.1`](https://github.com/whale4rain/tnega/compare/v0.4.0...v0.4.1) | 4 |
| 0.4.2 | [`v0.4.1...v0.4.2`](https://github.com/whale4rain/tnega/compare/v0.4.1...v0.4.2) | 53 |
| 0.4.5 | [`v0.4.2...v0.4.5`](https://github.com/whale4rain/tnega/compare/v0.4.2...v0.4.5) | 157 |
| 0.4.6 | [`v0.4.5...v0.4.6`](https://github.com/whale4rain/tnega/compare/v0.4.5...v0.4.6) | 56 |
| 0.4.7 | [`v0.4.6...v0.4.7`](https://github.com/whale4rain/tnega/compare/v0.4.6...v0.4.7) | 10 |
| 0.4.8 | [`v0.4.7...v0.4.8`](https://github.com/whale4rain/tnega/compare/v0.4.7...v0.4.8) | 6 |

Use `git log <previous-actual-tag>..<release-tag>` for the full changelog audit;
compare links provide a convenient browser view of the boundaries.

## Unreleased

- Session queries keep reporting a run as active when it finishes during the
  history read, so reconnecting clients poll again instead of missing its final reply.

- Project Threads now automatically route undecided tool permission requests
  to their direct parent. The parent can approve the exact waiting call once,
  deny it, or forward it to the user; cancellation, expiry and Project shutdown
  invalidate the request. Decisions are audited without changing permission
  presets or treating agent messages as human authorization.
  Human escalation preserves the full input, and shell approval cards also
  display working-directory and other execution parameters.

- Background Tasks now also shows workspace long-lived processes in chats and
  Projects: live status, start time, refreshing logs, local URLs opening in the
  Browser workbench, and a direct Stop control that terminates the process tree.
  Stopped process output remains available; process records are in-memory and
  require the matching server version for the new controls.

- Restore the desktop Browser after its last tab closes. Agent attachment and
  address-bar navigation now create a live replacement instead of using the
  closed page, which left navigation stuck without opening a website.

## [0.4.12](https://github.com/whale4rain/tnega/releases/tag/v0.4.12) — 2026-10-05

- Agent runs now continue and save their reply when the browser's SSE
  connection closes; stopping a run still requires the Stop action.
- Publish npm and the Windows desktop update source automatically when a
  prepared version tag is pushed. Stable and preview channels remain separate;
  fixed artifact checks and staged GitHub drafts make failed uploads retryable.
- Projects work like a team room. Every run of messages shows its author and
  time, days are separated, and the coordinator "is typing" while it writes.
  Hovering a thread card lets you reply to that thread directly. Agents now
  receive who is speaking and which message a reply answers.
- The project panel is the same Workbench a session uses: Board, Library and
  Routines lead its tabs, threads and project settings open as tabs, and it
  resizes and toggles with Ctrl+J. Files, Changes and Terminal stay available.
- The **Board** replaces Overview. It shows today's activity under the
  project's weather (threads opened, finished, outputs, tokens) and lanes for
  Needs you, Working, Ready and Idle threads, each card with its step or
  question, checklist progress, outputs, active time and tokens. Resolve a
  thread when you have taken its result; resolved threads fold away and
  reopen when they get a new message.
- **Routines** put recurring work on a schedule (daily, weekdays, weekly or
  every few minutes). Create them from the Routines tab or by asking the
  coordinator; each run goes to the routine's own thread.
- Threads can publish workspace files — Word, PowerPoint, Excel, PDF,
  images — as artifacts. The Library filters by type and previews them with
  the same viewers as workspace files.
- Project memory moves into project settings. The room and threads share a
  one-line message box that grows as you type.
- Windows sandbox: commands that start child processes and read their output
  (`npm run dev`, vite, esbuild, most test runners) fail inside the write
  sandbox because it cannot allow named pipes without lifting the write fence.
  Such failures now explain this, and `shell` / `process_start` can ask to
  run outside the sandbox with `escalate` and a justification; once that call
  is approved it really runs unsandboxed (approved calls used to stay
  confined). A confined dev server can look ready and fail its first request
  later; `process_start` now says so, `process_output` points at escalation
  once `spawn EPERM` appears, and the approval card shows when a call asks to
  leave the sandbox and why.
- PowerShell progress records no longer leak into captured output as a
  `#< CLIXML` block.
- Project threads no longer ask you for permission. Their tool calls are
  reviewed automatically for the coordinator, with your requests in the room
  as evidence; what is not approved goes back to the thread, which asks its
  coordinator, and the coordinator asks you only when the decision is yours.
- Tool calls fold behind one line while a turn runs ("Running npm test"),
  and a finished turn sums them up ("Used 6 tools: 3 reads, 2 commands")
  instead of listing every call.
- Settings → Models: register several chat models, edit or remove them,
  and choose the default; sessions still switch from the composer. Your
  existing model is kept as the first entry. Approval reviewers such as
  TypeSafe Jev stay under Approvals.
- Each project's coordinator has its own colour, so projects no longer look
  alike in the sidebar.
- Selects have an inset chevron and themed options.
- The agent browser keeps the address you typed and shows a loading bar
  until the page arrives.

## [0.4.11](https://github.com/whale4rain/tnega/releases/tag/v0.4.11) — 2026-10-03

- Projects are redesigned as a calm group chat. The main conversation holds
  what you said, what the coordinator said and one card per thread with only
  its title and status. Thread results stay in their thread: you get an
  unread dot and a desktop notification, and the coordinator no longer
  restates them. It speaks up only when a thread needs a decision you have to
  make, or when you ask. Messages you send to a thread no longer add notices
  to the main conversation.
- Threads keep a live checklist (`update_checklist`). The card shows the step
  in progress, and the thread view leads with the checklist, its outputs and
  its answers; the brief and every internal step fold away.
- Artifacts appear as cards on the message that produced them and in the
  Library. They open in place, and HTML artifacts run as interactive pages in
  a sandboxed frame. The server now serves artifact content and can stop one
  thread or every running agent in a project.

## [0.4.10](https://github.com/whale4rain/tnega/releases/tag/v0.4.10) — 2026-10-03

- The `shell` and `process_start` tools run commands in the system shell
  (PowerShell 7, then Windows PowerShell, Git Bash or cmd on Windows; `$SHELL`
  elsewhere) instead of always going through `cmd.exe`, and tell the model
  which syntax to use. Sandboxed Windows commands no longer open a console
  window. Git Bash cannot run inside the Windows sandbox and is rejected with
  a reason. PowerShell output is plain UTF-8 text (no CLIXML or colour codes),
  and output from programs that cannot switch to UTF-8 — including PowerShell
  under the read-only sandbox — is decoded with the system code page instead
  of turning into replacement characters. Killing a timed-out command also
  stops children the shell was still starting.
- Every finished reply has a visible **Fork from here** action that starts a
  new session continuing from that reply; the header menu's whole-session fork
  is now labelled "Fork entire session". Forking from a reply keeps the
  session's agent type, mode, model and title instead of falling back to a
  General session.
- Workbench Files can hide its file tree from the toolbar to give the editor
  the full width; the choice is remembered.
- Deleting a session or project, forgetting memory, discarding unsaved edits
  and error notices use the app's own dialog instead of the browser's native
  boxes.
- Ordinary tool errors the agent handles itself (a 404, a missing file,
  invalid input) no longer show as red failures; they fold into the completed
  process and their detail reads "Returned to the agent". Only failures a
  person must act on (sandbox, permissions, missing tool or credentials) stay
  flagged. The model still receives every error unchanged.
- Tool calls stream as a flat list while a turn runs instead of a folder that
  opens and closes around each call; they fold once when the turn finishes.
- Settings is reorganized into sections (Model, Approvals, Tools & shell,
  Appearance, About & updates) with a side navigation, so new options get a
  home without crowding one page. A failed save opens the section that needs
  fixing. Tools & shell adds a **Shell** choice (saved as `shell` in
  `config.json`); Appearance repeats the theme switch.
- When the agent asks a question or needs an approval, the desktop client
  sounds once, flashes the taskbar and shows a snow badge until you return to
  the window.

## [0.4.9](https://github.com/whale4rain/tnega/releases/tag/v0.4.9) — 2026-10-03

- Desktop sessions play one system sound when a run finishes. Unfocused Windows
  clients show a rain taskbar badge for a ready reply or lightning for a failed
  run; returning to the window clears it. Cancelled runs do not notify.

- Settings use a wider, responsive two-column layout with separate model and
  approval sections, keeping save actions visible while the content scrolls.

- Ship twelve offline skills for research, documents, planning, data processing,
  coding, debugging, review, TDD, DDD, Tnega usage and skill management. Install missing files in user home
  on startup, preserve user edits, and honor Workspace overrides. General,
  coding and Project agents discover short descriptions and load instructions
  on demand; no network download or additional tool permissions are required.

- Add guarded `skill_create` / `skill_install` tools and coding `/skills create`
  / `/skills install` commands, with live discovery after changes. Install from
  Workspace files or HTTPS raw Markdown; preserve existing files, enforce write
  permissions and do not execute downloaded content or copy companion assets.

## [0.4.8](https://github.com/whale4rain/tnega/releases/tag/v0.4.8) — 2026-10-03

- Preserve the desktop's theme when Browser attaches, opens tabs or reconnects;
  CDP connections no longer apply Playwright defaults to the host UI.
- Fix packaged Windows desktop sandbox execution: ship the ACL runner beside
  the main bundle and launch it in Electron's Node mode, with native koffi
  dependencies retained. Keep sandbox enforcement fail closed.

- Document user-run npm publishing, registry propagation delays, duplicate
  release recovery and transient Windows shortcut warnings during installation.

## [0.4.7](https://github.com/whale4rain/tnega/releases/tag/v0.4.7) — 2026-10-03

- Store default desktop/Web/CLI Sessions, subagent and Project Thread histories
  in `~/.tnega`, partitioned by Workspace path, with `TNEGA_HOME` overrides.
  Import legacy project records on first access without overwriting conflicts;
  retain backups and detect continued writes by old clients. Project configuration,
  memory, skills and artifacts stay in the Workspace; Session formats are unchanged.
- Resolve desktop PTC worker and QuickJS WASM from the shipped runtime resources
  for ordinary sessions, resident Agents and Project Threads, fixing missing
  `app.asar/out/worker.mjs` execution failures.
- Exclude generated Session logs and spill files from turn-level edited files
  and workbench Changes, while keeping project configuration, memory and skills
  visible. Correct edit paths for workspaces inside a larger Git repository.
- Let desktop users choose Stable or Preview (pre) updates in Settings, persist
  the choice across restarts and prevent pending updates from the old channel
  being installed. Switching to Stable does not downgrade an installed preview.
- Support `x.y.z-beta.N` release preparation, `beta.yml` preview feeds, GitHub
  prerelease validation and explicit npm `preview` publication guidance.
- Ensure every desktop release carries its `latest.yml` update feed, including
  recovery for an installer built without publishing.
- Reorganize English and Chinese guides, refresh screenshots, add this changelog
  and consolidate release instructions under `docs/publish/`.
- Audit all adjacent release tags, record historical Session format changes and
  define continuous changelog maintenance and stable/preview version policy.
- Ignore local `.pnpm-store/` and `data/` directories.

## [0.4.6](https://github.com/whale4rain/tnega/releases/tag/v0.4.6) — 2026-10-03

- Unify Files, Changes, Terminal, Browser, document previews and subagent
  transcripts in the right-hand Workbench, including image and PDF previews.
- Add a workspace file tree and syntax-aware editor with Ctrl+S and detection
  of concurrent disk changes; add unified/side-by-side Git diffs with live refresh
  and multiple PTY terminals. Ctrl+J toggles the panel; Ctrl+` opens the terminal.
- Add application-contained agent browsing in desktop and Web, browser tabs,
  a resizable viewport, screenshots and an element picker.
- Accept image attachments on messages and tool results; route them to vision
  models with a fallback for unsupported models.
- Add background commands and jobs with visible progress and stop controls;
  keep background workspace processes alive across Agent Runs.
- Load external plugins from profile files and hot-reload without restarting.
- Add a slash command to enable CodeMode.
- Improve project coordination and Thread reporting, including waiting for
  user decisions; show context compaction progress.
- Introduce the sky palette, measured dark theme, weather states and
  cloud-on-cube identity; simplify conversation controls.
- Add packaged desktop self-update from GitHub Releases, background downloads,
  an Update action and manual checks in Settings.
- Keep closed desktop windows running in the tray; ship the terminal's
  platform binaries in installers and refuse saves over invalid config files.
- **Breaking:** remove eval, evolve and benchmark packages and public exports.
  Session format remains v10. See [release notes](docs/releases/v0.4.6.md) and
  [ADR 0011](docs/adr/0011-remove-eval-first.md).

## [0.4.5](https://github.com/whale4rain/tnega/releases/tag/v0.4.5) — 2026-10-01

- Add Projects with a coordinator, parallel Threads, shared Memory and an
  artifact Library, including project archive and deletion.
- Add Work Sessions and Office tools to create, inspect and edit DOCX, XLSX
  and PPTX, including formatting, themes, native charts and cached Excel formula
  evaluation.
- Show generated Office files as conversation cards with side-panel previews,
  zoom and downloads; add slash commands across Session types and `@` mentions.
- Add fail-closed local sandbox providers for Linux, macOS and Windows, and
  persist Session tool permission choices.
- Add scoped automatic approval plugins, durable user questions and CodeMode
  orchestration with QuickJS; expose nested tool progress.
- Persist completed-run final answers and collapse intermediate activity.
- Configure model context windows, list only configured routes, show edited-file
  line counts after runs (also outside Git), and honor `.gitignore` in glob/grep.
- Redesign the local UI and desktop window controls; add tray restoration and
  fix CommonJS sandboxed preloads and Session writer ownership.
- Session format remains v10. See [release notes](docs/releases/v0.4.5.md).

## [0.4.2](https://github.com/whale4rain/tnega/releases/tag/v0.4.2) — 2026-09-24

- Add the Electron desktop host, native workspace selection and desktop
  packaging; revise the conversation and activity interface.
- Add durable subagents and inbox tools, persistent Goal mode and permission
  presets, with child-task progress in the UI.
- Add persistent user/workspace memory and tool-output spill to keep large
  results manageable.
- Add multiple model routes, capabilities and thinking levels;
  show provider usage and cache metrics.
- Improve context compaction rendering.
- Group Sessions by Workspace, keep Settings inside the app, switch configured
  models per Session, fix root-level glob matches and truncate oversized reads
  instead of failing.

## [0.4.1](https://github.com/whale4rain/tnega/releases/tag/v0.4.1) — 2026-09-14

- Preserve transcript lifecycle ordering after compaction.
- Honor explicit Anthropic credentials and attach failed Agent Runs to their
  user messages in the Web UI.

## [0.4.0](https://github.com/whale4rain/tnega/releases/tag/v0.4.0) — 2026-09-13

- Harden durable inbox claims, live Agent scheduling, cancellation and retry
  settlement; preserve same-turn steering order.
- Persist assistant attempt ownership, including reconnectable streams and
  forks.
- Resolve inherited prompts, tools and events in the Agent's scope; await
  request middleware and expose admitted step batches.
- Prefer `TNEGA_API_KEY` for the default model credential.
- Normalize non-streaming JSON responses in native stream adapters.
- **Breaking:** Session format becomes v10; incompatible older logs are rejected
  rather than migrated in place.

## [0.3.0](https://github.com/whale4rain/tnega/releases/tag/v0.3.0) — 2026-09-09

- Add Coding Sessions, Plan mode, skills, MCP and slash command pickers.
- Add durable turn/step events, append-only context compaction and a projected
  model surface while retaining compacted history in the human transcript.
- Align stream retries, cancellation causes, inbox steering and tool execution
  middleware; persist partial streams and show interrupted-run recovery.
- Add library subpath exports and isolated evaluation/benchmark workflows.
- Add resident multi-turn Agents with durable inboxes, profile-based startup,
  dynamic prompt variables and service seams. Evaluation importers support
  HumanEval, MBPP, BigCodeBench and SWE-bench.
- **Breaking:** Session format becomes v7 and the SessionProjector seam is
  removed. Old logs are not automatically migrated.

## [0.1.1](https://github.com/whale4rain/tnega/releases/tag/v0.1.1) — 2026-09-01

- Establish the plugin lifecycle core, Agent Loop, JSONL Sessions, tool execution
  pipeline, LLM adapters, CLI and React/Vite local Web interface.
- Add library/runtime composition and public domain exports.
- Support OpenAI-compatible and Anthropic providers, streaming replies,
  cancellation, refresh recovery, forks, edited-message resubmission and context
  compaction while retaining the human transcript; add dark mode.
- Expose declarative AgentDefinition and tool validation, authorization and
  truncation policies. Early eval/evolve tooling was later removed in 0.4.6.
- Switch the default model route for this release and prepare npm distribution.

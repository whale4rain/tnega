# Changelog

User-visible changes reconstructed from Git tags and commit history. Dates are
the tag commits' recorded dates. Version sections describe what shipped at that
point; historical capabilities may have since been removed. There are no Git
tags for 0.4.3 or 0.4.4, so no releases are inferred for those numbers.

## Unreleased

- Ensure every desktop release carries its `latest.yml` update feed, including
  recovery for an installer built without publishing.
- Reorganize English and Chinese guides, refresh screenshots, add this changelog
  and consolidate release instructions under `docs/publish/`.
- Ignore local `.pnpm-store/` and `data/` directories.

## [0.4.6](https://github.com/whale4rain/tnega/releases/tag/v0.4.6) — 2026-10-03

- Unify Files, Changes, Terminal, Browser, document previews and subagent
  transcripts in the right-hand Workbench.
- Add a workspace file tree and syntax-aware editor with Ctrl+S and detection
  of concurrent disk changes; add Git diffs and multiple PTY terminals.
- Add application-contained agent browsing in desktop and Web, browser tabs,
  a resizable viewport, screenshots and an element picker.
- Accept image attachments on messages and tool results; route them to vision
  models with a fallback for unsupported models.
- Add background commands and jobs with visible progress and stop controls;
  keep background workspace processes alive across Agent Runs.
- Load external plugins from profile files and hot-reload without restarting.
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
  and PPTX, including formatting, themes and native charts.
- Show generated Office files as conversation cards with side-panel previews,
  zoom and downloads; add slash commands across Session types and `@` mentions.
- Add fail-closed local sandbox providers for Linux, macOS and Windows, and
  persist Session tool permission choices.
- Add scoped automatic approval plugins, durable user questions and CodeMode
  orchestration with QuickJS; expose nested tool progress.
- Persist completed-run final answers and collapse intermediate activity.
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

## [0.4.1](https://github.com/whale4rain/tnega/releases/tag/v0.4.1) — 2026-09-14

- Preserve transcript lifecycle ordering after compaction.
- Honor explicit Anthropic credentials and attach failed Agent Runs to their
  user messages in the Web UI.

## [0.4.0](https://github.com/whale4rain/tnega/releases/tag/v0.4.0) — 2026-09-13

- Harden durable inbox claims, live Agent scheduling, cancellation and retry
  settlement; preserve same-turn steering order.
- Persist assistant attempt ownership, including reconnectable streams and
  forks; preserve transcript lifecycle ordering.
- Resolve inherited prompts, tools and events in the Agent's scope; await
  request middleware and expose admitted step batches.
- Prefer `TNEGA_API_KEY` for the default model credential.

## [0.3.0](https://github.com/whale4rain/tnega/releases/tag/v0.3.0) — 2026-09-09

- Add Coding Sessions, Plan mode, skills, MCP and slash command pickers.
- Add durable turn/step events, append-only context compaction and a projected
  model surface while retaining compacted history in the human transcript.
- Align stream retries, cancellation causes, inbox steering and tool execution
  middleware; persist partial streams and show interrupted-run recovery.
- Add library subpath exports and isolated evaluation/benchmark workflows.

## [0.1.1](https://github.com/whale4rain/tnega/releases/tag/v0.1.1) — 2026-09-01

- Establish the plugin lifecycle core, Agent Loop, JSONL Sessions, tool execution
  pipeline, LLM adapters, CLI and React/Vite local Web interface.
- Add library/runtime composition and public domain exports.
- Switch the default model route for this release and prepare npm distribution.

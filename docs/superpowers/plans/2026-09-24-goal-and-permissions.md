# Goal Mode and Permission Presets Implementation Plan

**Goal:** Add persistent goal mode, remove execute mode, and replace per-run booleans with read-only, workspace-write, and bypass permission presets plus human approval for escalation.

**Architecture:** Session metadata owns the selected conversation mode. Goal state is a separate durable Session event and goal runs use the resident Agent inbox. A per-run permission policy guards tool execution; an approval broker bridges a pending tool request to the Web client. Builtin file and network tools enforce their own operation boundaries.

**Tech Stack:** TypeScript, Cordis-style plugins, JSONL Session, React, SSE.

**Spec:** User request in this task; DSH local packages `goal/*`, `sandbox/sandbox-policy`, and `interaction/permission-presets` as design references.

## Constraints

- Keep legacy `execute` Session metadata readable and map it to a supported mode.
- Human approval is one call only, recorded with the tool result; a denied or disconnected request cannot execute.
- Read-only permits public web search/fetch; workspace-write permits workspace file changes. Bypass requires explicit selection.
- Preserve existing uncommitted work and commit each independent feature with Conventional Commits.
- Per developer instruction, do not add or run tests unless explicitly requested.

## Work

- [x] Replace the public mode selector with auto, plan, goal; migrate legacy execute on read. Make plan generation a terminal planning run and expose `/goal` and mode selection.
- [x] Add durable goal state and bounded resident auto continuation, plus goal lifecycle commands and model tools.
- [x] Add one permission preset field to the run API and UI; enforce it in the tool executor, including one-shot human approval over SSE and public-network rules.
- [x] Check type safety, lint, and build; commit independent changes and push.

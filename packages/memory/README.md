# Memory seam

Memory is a three-role capability seam:

| Role | Package | Responsibility |
| --- | --- | --- |
| Service Definition | `@tnega/memory` | `ctx.memory` contract for reading both scopes, explicitly saving a global preference, and replacing curated project notes |
| Service Provider | `@tnega/memory-local` | Markdown files, write serialization, size limits and atomic replacement |
| Consumer | `@tnega/tool-memory` | `remember_global` tool, prompt injection and project-memory curation after compaction |
| Consumer | `@tnega/memory-dream` | Dreaming: background curation of project memory from sessions that changed and went quiet |

The default provider stores global user preferences in `~/.tnega/MEMORY.md` and project notes in `<workspace>/.tnega/MEMORY.md`. Existing lowercase `memory.md` files are moved to the new names on first access. Global writes are allowed only during an Agent Run whose latest user message explicitly asks to remember something. Project memory is curated from each completed compaction by a separate model call; no task progress or one-off requests should be copied into it. Both files are limited to 4,000 characters and may be edited by the user.

The consumer reads both files at the first step of each Agent Run and puts their current contents in the model's leading system context. The request header records that snapshot, so a later edit of either file does not change the meaning of an earlier request. Memory writes are visible on the next Agent Run. Compaction still owns the current Session's work in progress; project memory is for durable facts shared by sessions in the same workspace.

## Dreaming

Compaction only curates memory for long sessions. Dreaming covers the rest: the web and desktop host mount `@tnega/memory-dream` on its root context, and every five minutes it looks at the System Config workspaces (plus the default workspace) for sessions that changed since their last dream and have been quiet for `memoryDream.idleMinutes` (10 by default). It reads only what users and the assistant said since the last dream (no tool calls or results, no messages from other agents), asks the model for the updated `MEMORY.md` in one request, and writes it through `ctx.memory`. Global memory is never written this way.

Sessions are read straight from the JSONL file, never opened as a log, because opening a log can repair it and a background reader must not write to a session another process is running. Progress per session (last event read, event count) is kept in `<tnega home>/workspaces/<key>/memory-dream.json`; a failed request leaves it unchanged so the same conversations are read next time. One dream runs at a time across all workspaces, a workspace is dreamed at most every 15 minutes, and after a failure it waits 30 minutes. `GET /api/memory/dream?workspace=` reports the last dream and `POST` runs one now. Settings > Model > Dreaming turns it off, picks the model route and sets the quiet time. The consumer does not import a memory provider: the host passes `openMemory`, which mounts `@tnega/memory-local` for one dream.

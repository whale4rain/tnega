# Memory seam

Memory is a three-role capability seam:

| Role | Package | Responsibility |
| --- | --- | --- |
| Service Definition | `@tnega/memory` | `ctx.memory` contract for reading both scopes, explicitly saving a global preference, and replacing curated project notes |
| Service Provider | `@tnega/memory-local` | Markdown files, write serialization, size limits and atomic replacement |
| Consumer | `@tnega/tool-memory` | `remember_global` tool, prompt injection and project-memory curation after compaction |

The default provider stores global user preferences in `~/.tnega/memory.md` and project notes in `<workspace>/.tnega/memory.md`. Global writes are allowed only during an Agent Run whose latest user message explicitly asks to remember something. Project memory is curated from each completed compaction by a separate model call; no task progress or one-off requests should be copied into it. Both files are limited to 4,000 characters and may be edited by the user.

The consumer reads both files at the first step of each Agent Run and puts their current contents in the model's leading system context. The request header records that snapshot, so a later edit of either file does not change the meaning of an earlier request. Memory writes are visible on the next Agent Run. Compaction still owns the current Session's work in progress; project memory is for durable facts shared by sessions in the same workspace.

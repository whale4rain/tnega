# Projects: a room where people and agents work together

Status: design of record, 2026-10-04. Supersedes the UI parts of
[README.md](README.md) where they differ. The runtime (Box, Blackboard, Thread,
Project Loop) is unchanged; see [ADR 0008](../adr/0008-project-box-blackboard.md).

This document keeps the owner's intent in their own words first, then turns it
into principles, surfaces and a phased plan. When a later change is in doubt,
the intent section is the tie-breaker.

---

## 1. The owner's intent

### 1.1 Round one (2026-10-03): calm

> * Group-chat structure. The main chat is short and easy to skim. Each focused
>   task gets its own thread, shown as one card with a title and status.
> * Coordinator plus threads. I watch the main chat, start threads and pass
>   your messages to them. Each thread is its own long-lived Claude session on
>   a separate cloud computer. That's why threads take a moment to start, and
>   why several can work in parallel.
> * Results stay where the work happened. Threads report in their own thread
>   and notify you, and I don't repeat that here. I speak up when something
>   needs you or when you ask.
> * Progressive disclosure. You see outcomes first. Reasoning and internal
>   steps stay hidden unless you ask.
> * Visible status. A working thread shows a live checklist, so you always
>   know what's happening (Nielsen's "visibility of system status").
> * Outputs as cards. Artifacts are interactive webpages attached to messages
>   and collected in the Library, not pasted into the chat.
> * Restraint. One voice, few colors and no logs, so the important parts
>   stand out.
> * Long-term continuity. Auto-compaction condenses long conversations, shared
>   memory keeps lasting facts, and threads keep each topic's context separate.
>
> The main lesson for your taste: calm comes from deciding what not to show.

### 1.2 Round two (2026-10-04): a room, a board, real resources

> We call it Projects, which means we are intending it to shoulder a long term
> task, and this is the reason why we want its interaction experience is
> similar to people cooperate with each other: the session is transferred to a
> chat room rather than the regular gen-AI style's chat box. Think about what
> info would be shown or be sent, to be more precise. So the main agent should
> act as a real human, which can reply to a human, and a human can reply to
> them also. (There is a cutting-edge way we would implement, which may make
> this chat room contain not only one human but multiple humans as a team
> cooperating on a project.)
>
> About the side bar: we have reclaimed threads as not subagents; they show
> checklists to be kept following up by users, and the artifacts' Library also
> serves this intent. Further, the side bar is not only a display of threads,
> but also a kanban board for users to track this work and grab results. The
> Claude project also holds routines to manage routine tasks; memory should be
> stuffed into somewhere else. A kanban should contain more info, should be
> more friendly so users are willing to open it and check progress; design it
> as an interesting place — such as Claude, where the side bar shows how many
> threads opened today.
>
> A thread's resource consumption is also a topic: a live thread consumes some
> resources, and in Claude they work in a single cloud computer. We don't
> really need a cloud compute environment but it is instructive: a thread is
> individual. And their artifacts are various: docs, PPTs, HTML pages…
>
> Concrete asks: the side bar of a project should act as in a normal session;
> the chat input box of main and threads holds the same size (shrunk to one
> line); the overview should display more.

---

## 2. Principles

1. **A room, not a chat box.** Every message has an author, a time and,
   when it answers something, what it answers. Agents are participants with
   names, not a text generator below a prompt.
2. **The coordinator is a teammate.** It replies *to* someone, can answer two
   messages at once, stays quiet when nothing needs anyone, and asks short
   questions when a decision is a person's.
3. **Threads are colleagues with their own desk.** A thread is an individual:
   its own Session, folder, processes and budget. It is not a subagent: people
   open it, talk to it, follow its checklist and take its results.
4. **Results stay where the work happened** (round one), and the **Board is
   where you go to collect them**.
5. **Outcomes first, details on request; calm by subtraction** (round one).
   The room stays short. The Board may be rich, because opening it is a
   choice — but every piece of information on it must help someone decide to
   open, answer, take or close a thread.
6. **Precise about what is sent.** What a model receives is exactly what the
   room shows, with the speaker and the reply target spelled out; nothing is
   inferred from prose.
7. **Long-term.** Memory, instructions and routines make the project outlive
   any one conversation; they live in settings and on the Board, not in the
   chat.

---

## 3. The room (main conversation)

### 3.1 Message anatomy

| Part | Shown | Sent to the model |
| --- | --- | --- |
| Author | Name and avatar at the head of each run of messages from one author | The envelope's sender, as the message's speaker |
| Time | On the run head; day separators ("Today", "Yesterday", a date) | `createdAt` |
| Reply target | A small quote chip above the message ("↩ Coordinator: …") | `causationId` / `replyTo`, rendered as "in reply to …" |
| Body | Markdown | Text |
| Attachments | Artifact cards | Artifact references (hash, title, type), never the content |
| Hand-off | A thread card (title + status) | The dispatch envelope |

Runs: consecutive messages by the same author within a few minutes share one
head, the way chat apps group them. While the coordinator is composing, the
room shows "**Coordinator** is typing…" instead of an AI "Thinking" line.

### 3.2 Replies, both ways

- People reply to the coordinator (hover a message → Reply). The coordinator's
  answer carries the reply link, so a long room still reads as conversations.
- The coordinator replies to people. When it answers something other than the
  message right above, the reply chip says which.
- Replying to a thread card routes the message to that thread (a direct
  message, shown in the thread), not to the coordinator.

### 3.3 What stays out

Thread results, notices about thread messages, tool steps and reasoning stay
out of the room (round one). Activity that matters to everyone — "Routine
*Weekly digest* started a run" — appears as one quiet line at most.

### 3.4 Many people (roadmap)

The data model already separates the sender from the text. Making the room a
team space needs:

- user identities instead of the single `user` address (`{ kind: 'user', id }`
  with a profile: name, avatar colour);
- per-person unread and notification state (today it is per browser);
- `@name` mentions to address a person or a thread explicitly;
- attribution on every message an agent sends on someone's behalf ("on behalf
  of @jordan"), as Claude Tag does;
- presence (who is in the room now) and per-person drafts.

Until then the single human is "You".

---

## 4. Threads: individuals with their own desk

### 4.1 Lifecycle and states

| Thread state | Board column | Meaning |
| --- | --- | --- |
| `waiting`, `blocked`, `failed` | **Needs you** | A decision, access or a fix only a person can give |
| `working` | **Working** | Running a turn now |
| `done` / `idle`, not yet opened since it reported | **Ready** | It reported; the result is waiting to be collected |
| `done` / `idle`, already seen | **Idle** | Nothing pending; can take more work |
| `resolved` | **Resolved** | A person (or the coordinator, after the last step) closed it. Reopens when it gets a message |

`resolved` is new: it is the person's "I have taken this" — distinct from the
agent's `done`. Resolved threads fold away on the Board.

### 4.2 A thread is an individual

In Claude each thread is a separate cloud computer. Tnega runs locally, but the
lesson holds: a thread owns

- its **Session** (history, compaction) — already true;
- its **folder** (`agents/<id>/`) and, for code work, optionally its own git
  worktree (roadmap, needs a merge-back story);
- its **processes** (background jobs it started);
- its **consumption**: tokens and active time, shown on its Board card and
  summed for the project.

A thread that has been idle for a while can be **put to sleep**: its LiveAgent
is released (memory, file handles) while its Session stays; the next message
wakes it. That mirrors Claude's "sandbox released, thread persists" and keeps
twenty idle threads from holding resources. (Roadmap; the UI already
distinguishes live from idle.)

### 4.3 Checklist

Threads keep a live checklist (`update_checklist`). The card shows the active
step; the Board shows progress; the thread view shows the list first.

---

## 5. The side panel: Board, Library, Routines

The side panel behaves like a normal session's Workbench: same place, same
toggle (Ctrl+J and the header button), drag to resize, and the same shape —
a tab rail, a toolbar row, content in a rounded card. Opening a thread opens it
in the panel; Back returns to the tab you were on.

Tabs: **Board · Library · Routines**. Memory and project instructions move to
**Project settings** (opened from the header), because they are standing
configuration, not something you check during the day.

### 5.1 The Board — a place worth opening

Header strip, "Today": threads started today · finished today · artifacts made
today · tokens used today, and the project's **weather** (the brand's state
language): storm if something failed, snow if something waits on you, rain if
several threads work, drizzle if one does, clear when all is quiet. One glance
answers "is anything happening, does anything need me?".

Columns, in this order, each with a count: **Needs you · Working · Ready ·
Idle**, then a folded **Resolved (n)**.

Card anatomy (richer than the room's card, still one idea per line):

- title, and the thread's weather on its avatar;
- the current step (working), the question it is asking (needs you), or the
  first line of its report (ready);
- checklist progress bar `3/5`;
- artifact chips by type (Doc, Slides, Sheet, Page, Data…);
- footer: last activity ("4 min ago"), active time, tokens;
- actions on hover: Open, Resolve / Reopen, Stop.

Empty Board: a short line and the weather — never a wall of zeros.

### 5.2 Library

Everything people added and threads produced, filterable by type: **Pages,
Docs, Slides, Sheets, Data, Code, Text, Links**. Opening an artifact previews
it in place: HTML in a sandboxed frame, Markdown rendered, Word / PowerPoint /
Excel through the existing office previews, images and PDF natively. Each item
says which thread made it and links back to the message it was attached to.

Artifacts become binary-capable: `publish_artifact` accepts a workspace `path`
(a .docx, .pptx, .xlsx, .pdf, image…) as well as inline `content`, and stores a
content-addressed snapshot, so later edits to the file do not rewrite history.

### 5.3 Routines

Recurring work the project owns: "every weekday at 09:00, summarise new
issues". A routine is a stored instruction with a schedule; each run is
delivered to a thread (its own, created on first run and reused), so its
results land in that thread and on the Board like any other work. The
coordinator can create one when asked ("put this on a schedule"); people can
pause, resume, run now or delete it from the Routines tab, which shows the
schedule, the next run and the last result. Pausing the project pauses its
routines.

---

## 6. Input boxes

The room and every thread use the same message box, one line tall at rest,
growing with the text up to a cap. Same height, same controls, so moving
between the room and a thread does not change the feel of typing.

---

## 7. Plan

### Phase 1 — delivered 2026-10-04

All nine items below shipped, plus one found on the way (#10). Verified with
unit tests and in the running Web UI against a scripted model.

| # | Change | Where |
| --- | --- | --- |
| 1 | Side panel as a Workbench: rail tabs, resizable width shared with the session Workbench, Ctrl+J | `ProjectView`, `project.css` |
| 2 | One-line message box, same size in room and thread | `PromptBox` (`rows` option), `ProjectView`, `ThreadPanel` |
| 3 | Board replaces Overview: Today strip with weather, columns, rich cards, resolve / reopen / stop | `ProjectPanels` (`BoardPanel`), `project-model` (`board`, `today`) |
| 4 | `resolved` thread state, set and cleared by people; a message reopens it | `@tnega/thread`, `thread-local`, project host route `PATCH …/threads/:id` |
| 5 | Usage per thread (tokens, responses, active time) | host `GET …/usage`, Board cards |
| 6 | Memory and instructions move to Project settings | `ProjectPanels` (`SettingsPanel`) |
| 7 | Room as a chat room: author heads with time, day separators, "is typing…", reply to a thread card goes to the thread | `ProjectView` |
| 8 | Routines: stored schedule, host scheduler, coordinator tool, Routines tab | `@tnega/cli` project host, `tool-routine` in `tool-thread`, `ProjectPanels` |
| 9 | Binary artifacts from workspace paths, typed Library with filters and office previews | `tool-blackboard`, artifact route, `Artifacts.tsx` |
| 10 | Precise input: a child's report reaches its parent as "[Report from thread "…" (id)]", a person's reply as "[In reply to …: "…"]"; the server stores the reply target the UI sends | `project-loop` (`renderEnvelope`), host `sendUserMessage` |

Notes from building it:

- The project panel *is* the session Workbench: App passes the project's tabs
  to `Workbench`, which renders a slot; `ProjectView` portals the active tab
  into it, so the tabs share the view's live state. Files, Changes, Terminal
  and Browser stay available after a divider.
- The Board stacks its lanes in a narrow panel (empty lanes hidden) and lays
  them out as a four-column kanban from 720 px wide (a CSS container query).
- Routines run while the project is mounted in a running Tnega; a run missed
  while nothing ran happens once on the next tick. They are `routine` facts
  on the project Blackboard.

### Phase 2 (roadmap)

- Several people in one room (§3.4).
- Thread sleep after idle, and per-thread worktrees for parallel code work
  (§4.2).
- Budgets: a per-project token cap and a visible "N live threads" limit.
- Routine triggers beyond time (a file changes, a PR updates).
- Suggested threads: the coordinator proposes, a person starts them with one
  click.

---

## 8. References

- Claude Code docs, *Let Claude coordinate ongoing work with Projects*
  (code.claude.com/docs/en/claude-projects): Overview groups (Ready for review,
  Waiting on you, Working, Landing, Idle, Resolved), Library / Pull requests /
  Routines tabs, memory and instructions under Project settings, usage by
  thread, Pause / Archive / Delete, 200 new threads a day.
- Claude Tag docs, *How Claude Tag works* (claude.com/docs/claude-tag): several
  people steer one thread by replying; the checklist as the progress surface;
  one sandbox per thread, released when quiet and rebuilt on the next reply;
  attribution lines; per-channel memory.
- Nielsen, *10 Usability Heuristics*, #1 visibility of system status.

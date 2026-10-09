# Using Tnega

Reference for day-to-day use. The [README](../../README.md) gives the overview
and quick start; this page holds the details.

## Conversations and context

General, Coding and Work Sessions use JSONL event
logs. Fork a Session, edit and resend a message, compact context, inspect model
usage and cache metrics, or expand the process behind a completed run's final
answer. Attach, paste or drop images for vision models. User preferences live in
`~/.tnega/MEMORY.md`; workspace conventions live in `.tnega/MEMORY.md`.

## Models, plugins and CodeMode

Configure multiple OpenAI-compatible or Anthropic Messages
routes in Settings, then select a model and thinking level per Session. External
plugins load from profile files and hot-reload in the Web and desktop hosts.
Optional CodeMode lets JavaScript orchestrate the existing tools through QuickJS.

## Permissions and sandbox

Choose read-only, workspace-write or bypass. Ask me and Auto
review control approval separately; automated review falls back to a human when
it cannot decide. Shell writes are constrained by a local sandbox on Linux,
macOS and Windows. A missing sandbox mechanism refuses restricted execution.
Bypass explicitly runs without a sandbox. See the
[approval guide](../../packages/auto-approval/README.md) and
[sandbox design](../adr/0008-sandbox-seam.md).

## Interface

Light, dark and system themes share the sky palette; weather
symbols communicate agent state. `Ctrl+J` toggles the Workbench and
`` Ctrl+` `` opens the terminal. The desktop app shares the Web host's config and
Session data and keeps running in the system tray when its window is closed.

Settings → Appearance also offers the Sky, Sand, Forest and Graphite palettes
(each light and dark), density, text size and conversation width.

## Where data lives

Desktop and Web Sessions, CLI run logs, subagent transcripts
and Project Thread histories live under `~/.tnega/sessions/<workspace-key>/`.
Project messages and identities live under `~/.tnega/workspaces/<workspace-key>/`.
The key is a hash of the absolute Workspace path; `TNEGA_HOME` overrides the
home directory. Workspace configuration, custom skills, memory and project artifacts
stay in the project. Close old clients before upgrading: existing project logs
are imported on first access, with original files retained as backups. Different
copies or a legacy writer continuing after import cause an explicit error;
neither copy is overwritten. This relocates files without changing their Session
format. An explicit CLI `--session` path is still honored.

## Built-in skills

Desktop/Web startup and the default CLI runtime install twelve
bundled skills offline into `~/.tnega/skills/<name>/SKILL.md` (or
`TNEGA_HOME/skills`). They cover source research, documents, planning, data files,
implementation, debugging, code review, TDD, DDD, Tnega usage and skill authoring/installing. General, coding and
Project agents see a short trigger index and read relevant instructions with
`skills_list` / `skill_read`; coding Sessions also provide `/skills`.
Existing user files are never overwritten; upgrades only add missing skills.
Add your own skills in the same directory, or override a name for one Workspace
with `.tnega/skills/<name>/SKILL.md`. Skills do not change tool permissions.

Use `/skills read <name>` for an explicit read (including names such as `create`).
Coding Sessions support `/skills create <name> <description>` to create a starter
template and `/skills install <workspace-path-or-HTTPS-raw-URL> [name]` to import
a `SKILL.md`. Agents also have `skill_create` (complete content or a template)
and `skill_install`. Both write to user home and require write permission; they
never overwrite existing instructions. Installation copies only `SKILL.md`,
not referenced assets or scripts. Model HTTPS installs require the runtime's
`http_get` network tool; a typed slash URL explicitly requests the download.

## Desktop updates

**Desktop 0.4.6 and later update inside the app.** It checks at startup and every
four hours, downloads a new release in the background and shows **Update** next
to Settings when ready. Click it to install and restart, or use **Settings →
Check for updates**. Users do not need to build or download each later installer.
Older clients need a one-time installation of an update-capable version.

In versions with channel selection, **Settings → Update channel** offers
**Stable** (default) and **Preview (pre)**. Preview includes `x.y.z-beta.N` early
releases and newer stable releases. The choice persists across restarts.
Switching back to Stable waits for a matching or newer stable release; it does
not downgrade an installed preview or install a pending preview download.

## Version policy

Update `CHANGELOG.md` under **Unreleased** in the same change as each user-visible
feature, fix or compatibility change. Audit every release against the previous
actual Git tag, including merged branches and skipped version numbers.

Commits remain small, independently verifiable Conventional Commits. A release
is a larger delivery batch: publish after several new features are stable and
the relevant checks pass, rather than bumping a version for every commit.
The agent may choose and increment the third (**patch**) number autonomously.
Changing the first (**major**) or second (**minor**) number requires the user's
decision. Preview releases use `x.y.z-beta.N`, share the planned stable version
and increment `N` for each preview; promote to `x.y.z` when ready. See
[docs/publish](../publish/README.md) for channel selection and release checks.

<p align="center">
  <img src="docs/assets/tnega-icon.png" alt="Tnega: a white cloud with two eyes" width="112" />
</p>

<h1 align="center">Tnega</h1>

<p align="center">
  <b>A local workspace where agents write code, edit documents and run whole projects alongside you.</b><br />
  Desktop app, Web UI, terminal client and a TypeScript agent harness. “Tnega” is “agent” backwards.
</p>

<p align="center">
  <a href="https://github.com/whale4rain/tnega/releases/latest">Download</a> ·
  <a href="#install">Install</a> ·
  <a href="docs/guide/README.md">Guide</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/zh-CN.md">中文</a>
</p>

![A coding session beside the Workbench, with the edited file open in Files](docs/assets/workbench.png)

## Why Tnega

- **Everything in one window.** The conversation sits beside a Workbench with
  your files, Git changes, terminals and a browser the agent can drive, so you
  review its work where it happens.
- **Projects that work like a team.** Give a project a goal and talk to it like
  a group chat. A coordinator routes each ask into its own Thread, and each
  Thread works in its own Git worktree and hands back a short report or a pull
  request.
- **Bring your own model.** Any OpenAI-compatible or Anthropic Messages route,
  such as DeepSeek, OpenAI, Anthropic or a local server, chosen per session
  with its thinking level.
- **Safe by default.** Shell writes run in a local sandbox on Linux, macOS and
  Windows, and Tnega refuses to run restricted commands when no sandbox is
  available. Approvals can ask you, or let a reviewer model decide and ask you
  when it is unsure.
- **Your data stays local.** Sessions are plain JSONL event logs under
  `~/.tnega`. Nothing leaves your machine except the model requests you
  configure and the network tools you turn on.

## What you can do

**Code.** Coding agents with Auto, Plan and long-running Goal modes, workspace
search, file tools, `@` file mentions, slash commands, skills and MCP servers.

**Work with documents.** Create and edit DOCX, XLSX and PPTX, with themes,
tables and native charts. Generated files open as previews you can zoom and
download.

**Run projects.** The Board says in a sentence what needs you and what is
ready, with cards for Threads, outputs and pull requests. You can reply to any
Thread directly; the coordinator's notes to a Thread fold into its chat.

**Review and browse.** Files with syntax highlighting and safe saves, unified or
side-by-side diffs, terminals that survive tab switches, and an agent browser
with tabs, screenshots, console and network views and an element picker.

**Keep long tasks moving.** Background jobs show progress and can be stopped.
The agent can ask you a question and wait, or carry on while you decide. After
a crash or restart, sessions and Threads continue where they stopped.

![A project Board with a Thread waiting on you and one with a result ready](docs/assets/projects.png)

Light, dark and system themes come in five palettes: Carbon, a calm neutral
grey (the default), Sky, Sand, Forest and Graphite. Density, text size and
conversation width are adjustable. A small weather language shows what each
agent is doing at a glance.

## Install

### Desktop

Download the installer for your system from
[Releases](https://github.com/whale4rain/tnega/releases/latest):

| System | File |
| --- | --- |
| Windows | `Tnega-Setup-<version>.exe` |
| macOS, Apple silicon / Intel | `Tnega-<version>-arm64.dmg` / `Tnega-<version>-x64.dmg` |
| Linux | `Tnega-<version>-x86_64.AppImage` or `Tnega-<version>-amd64.deb` |

Open it, then add your model and API key in **Settings**. Windows and Linux
update themselves. The macOS app is not signed with an Apple Developer ID: the
first time, allow it under **System Settings → Privacy & Security → Open
Anyway**, and later updates show **Download** instead of installing in place.

### npm (Web UI and terminal)

Requires **Node.js 22.19 or later**.

```bash
npm install -g tnega
tnega web          # then open http://127.0.0.1:3080 and set your model in Settings
```

## The terminal client

Run `tnega` in the folder you want the agent to work on. It opens the terminal
client, which shares sessions with the Web and desktop apps.

![The terminal client after a finished run](docs/assets/tui.png)

```bash
tnega                  # start a session here (same as tnega tui)
tnega tui --continue   # reopen the latest session in this folder
tnega --help           # every command and option
```

Replies stream in with folded tool steps, `/` and `@file` completion, tool
approvals, diffs and the model picker. Press `?` on an empty prompt to see
every key. While the agent works, Enter queues your next message for after the
run, Tab steers the agent with it right away, and Esc stops it. A small weather strip in the status line shows what it is
doing. Projects open in the Web app with `/web`. The
[TUI README](packages/tui/README.md) lists the keys and commands.

To run a single task without any interface:

```bash
export TNEGA_API_KEY=your-api-key
tnega run "Reply with: hello"
tnega run --allow-shell "list the files here"   # shell tools are opt-in
```

On PowerShell, set the key with `$env:TNEGA_API_KEY = 'your-api-key'`. The
[CLI guide](packages/cli/README.md) covers model routes, environment variables
and flags.

## Learn more

- [Using Tnega](docs/guide/README.md): sessions, models, permissions and the
  sandbox, where data lives, skills and desktop updates.
- [Projects](docs/project/README.md): how the coordinator, Threads, Memory and
  the Library fit together.
- [Design guide](docs/design/tnega-design.md): the interface rules, colours and
  the weather language.
- [Architecture decisions](docs/adr/): persistence, sandboxing, approval,
  CodeMode and the browser.

## Build on the harness

The npm package is also a TypeScript library. Tnega's core is a composable
Agent Harness: scoped plugins connect the model, tools and durable Sessions,
and disposing a plugin reverses everything it registered. Capabilities such as
search, sandbox and browser are seams: a service definition with swappable
providers and consumers.

Start with [core](packages/core/README.md), [agent](packages/agent/README.md),
[CLI and runtime](packages/cli/README.md) and the [domain vocabulary](CONTEXT.md).

## Develop

```bash
pnpm install
pnpm tnega web --port 3080        # runtime and Web server
pnpm --filter @tnega/web dev      # Web UI with hot reload
pnpm tnega tui                    # terminal client from source
```

Run the checks your change needs: `pnpm test`, `pnpm typecheck`, `pnpm lint`
and `pnpm build`. Contributor rules are in [AGENTS.md](AGENTS.md), and desktop
work lives in [apps/desktop](apps/desktop/README.md). Feature PRs leave
`CHANGELOG.md` alone; the release-prep PR writes it. Releases are cut by
pushing a version tag, see [docs/publish](docs/publish/README.md).

## License

[MIT](LICENSE)

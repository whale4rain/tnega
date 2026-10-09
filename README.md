<p align="center">
  <img src="docs/assets/tnega-icon.png" alt="Tnega: a blue cloud with white eyes" width="120" />
</p>

<h1 align="center">Tnega</h1>

<p align="center">
  <b>A local workspace where agents write code, edit documents and run whole projects alongside you.</b><br />
  Desktop app, local Web UI, CLI and a TypeScript agent harness. “Tnega” is “agent” backwards.
</p>

<p align="center">
  <a href="https://github.com/whale4rain/tnega/releases/latest">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/guide/README.md">Guide</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/zh-CN.md">中文</a>
</p>

![Coding conversation beside the workspace file tree and editor](docs/assets/workbench.png)

## Why Tnega

- **Everything in one window.** The conversation sits beside a Workbench with
  your files, Git changes, terminals and a browser the agent can drive, so you
  review its work where it happens instead of switching tools.
- **Projects, not just chats.** Hand a goal to a coordinator. It splits the work
  into parallel Threads, each with its own agent, and keeps a shared Memory and
  a Library of results. The main room shows decisions and outcomes; the detail
  stays in each Thread.
- **Bring your own model.** Any OpenAI-compatible or Anthropic Messages route,
  such as DeepSeek, OpenAI, Anthropic or a local server, chosen per Session with
  its thinking level.
- **Safe by default.** Shell writes run in a local sandbox on Linux, macOS and
  Windows, and Tnega refuses to run restricted commands when no sandbox is
  available. Approval can ask you, or let an LLM reviewer decide and escalate
  when it is unsure.
- **Your data stays local.** Sessions are plain JSONL event logs under
  `~/.tnega`. Nothing leaves your machine except the model requests you
  configure and the network tools you enable.

## What you can do

| | |
| --- | --- |
| **Code** | Coding agents with Auto, Plan and long-running Goal modes; workspace search, file tools, `@` file mentions, slash commands, skills and MCP servers. |
| **Work with documents** | Create, inspect and edit DOCX, XLSX and PPTX, including themes, tables and native charts. Generated files open as previews you can zoom and download. |
| **Run ongoing projects** | A coordinator dispatches Threads, a Board shows what needs you, what is working and what is ready, and you can message any Thread directly. Agents only get the tools their role needs, which keeps token use down. |
| **Review and edit** | Files with syntax highlighting and conflict-aware saves, unified or side-by-side Git diffs, multiple terminals that survive tab switches. |
| **Browse** | The agent browser has tabs, screenshots, console and network inspection, and an element picker. It runs inside the app on desktop and on the Web. |
| **Keep long tasks moving** | Background jobs with progress and stop controls; the agent can ask you a question and wait, or carry on while you decide. |

![Reviewing Git changes in the dark theme](docs/assets/changes-dark.png)

Light, dark and system themes come in four palettes (Sky, Sand, Forest,
Graphite), with adjustable density, text size and conversation width. Weather
symbols show what each agent is doing at a glance.

## Quick start

### Windows desktop

Download `Tnega-Setup-<version>.exe` from
[Releases](https://github.com/whale4rain/tnega/releases/latest), install it and
add your model and API key in **Settings**. The app updates itself from then on.

### CLI and local Web (Windows, macOS, Linux)

Requires **Node.js 22.19 or later**.

```bash
npm install -g tnega
tnega web
# Open http://127.0.0.1:3080 and configure your model in Settings.
```

Run a single task headlessly:

```bash
export TNEGA_API_KEY=your-api-key
tnega run "Reply with: hello"
tnega run --allow-shell "list the files here"   # shell tools are opt-in
```

On PowerShell, set the key with `$env:TNEGA_API_KEY = 'your-api-key'`. See the
[CLI guide](packages/cli/README.md) for model routes, environment variables and
flags.

Pick **Coding** for repository work, **Work** for Office files or **General**
for anything else. Open **Projects** for longer efforts with a coordinator,
Threads and shared Memory; the [Project guide](docs/project/README.md) explains
how they work.

## Learn more

- [Using Tnega](docs/guide/README.md): sessions, models, permissions and the
  sandbox, where data lives, built-in skills and desktop updates.
- [Design guide](docs/design/tnega-design.md): the interface rules, colors and
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
[CLI/runtime](packages/cli/README.md) and the [domain vocabulary](CONTEXT.md).

## Develop

```bash
pnpm install
pnpm tnega web --port 3080        # runtime + Web server
pnpm --filter @tnega/web dev      # Web UI with hot reload
```

Run the checks your change needs: `pnpm test`, `pnpm typecheck`, `pnpm lint`
and `pnpm build`. Desktop development lives in [apps/desktop](apps/desktop/README.md).
Releases are cut by pushing a version tag; read [docs/publish](docs/publish/README.md)
first and keep [CHANGELOG.md](CHANGELOG.md) current.

## License

[MIT](LICENSE)

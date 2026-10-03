<p align="center">
  <img src="docs/assets/tnega-icon.png" alt="Tnega: a cloud on a cube" width="120" />
</p>

# Tnega

[中文](docs/zh-CN.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/whale4rain/tnega/releases) · [Publishing](docs/publish/README.md)

Tnega is a local agent workspace for coding, document work and ongoing projects.
Chat with an agent, review its changes, edit files, run a terminal and browse the
web in the same interface. Underneath is a composable Agent Harness: scoped
plugins connect the model, tools and durable Sessions, and can be replaced or
disposed without leaving their effects behind. “Tnega” is “agent” backwards.

## See it in action

![Coding conversation beside the workspace file tree and editor](docs/assets/workbench.png)

*The current Web interface, with isolated demonstration data.*

![Reviewing Git changes in the dark workbench](docs/assets/changes-dark.png)

*The same workspace in dark mode, with the Changes tool open.*

## What you can do

| Workflow | Included capabilities |
| --- | --- |
| **Code** | Coding agents with Auto, Plan and persistent Goal modes; workspace search, file tools, slash commands, skills, MCP servers and `@` file mentions. |
| **Work with documents** | Work agents create, inspect and edit DOCX, XLSX and PPTX, including themes, tables and native charts. Generated files appear as cards with previews, zoom and download. |
| **Run ongoing projects** | A coordinator delegates to parallel Threads; inspect progress and message a Thread directly. Projects share Memory, instructions and a Library of artifacts. |
| **Review and edit** | One right-hand Workbench holds Files, Changes, Terminal and Browser, plus closable document and subagent transcript tabs. Files has a workspace tree, syntax highlighting and Ctrl+S; saves detect newer disk changes. Changes offers unified and side-by-side Git diffs. |
| **Use your terminal and browser** | Multiple PTY terminals stay open across tab switches. The agent browser supports tabs, screenshots, console/network inspection and an element picker. It stays inside the app in both desktop and Web hosts. |
| **Keep long tasks moving** | Background commands and delegated jobs expose progress and stop controls. Durable questions let the agent ask for a decision; blocking questions wait for an answer. |

**Conversation and context.** General, Coding and Work Sessions use JSONL event
logs. Fork a Session, edit and resend a message, compact context, inspect model
usage and cache metrics, or expand the process behind a completed run's final
answer. Attach, paste or drop images for vision models. User preferences live in
`~/.tnega/MEMORY.md`; workspace conventions live in `.tnega/MEMORY.md`.

**Models and tools.** Configure multiple OpenAI-compatible or Anthropic Messages
routes in Settings, then select a model and thinking level per Session. External
plugins load from profile files and hot-reload in the Web and desktop hosts.
Optional CodeMode lets JavaScript orchestrate the existing tools through QuickJS.

**Permissions.** Choose read-only, workspace-write or bypass. Ask me and Auto
review control approval separately; automated review falls back to a human when
it cannot decide. Shell writes are constrained by a local sandbox on Linux,
macOS and Windows. A missing sandbox mechanism refuses restricted execution.
Bypass explicitly runs without a sandbox. See the
[approval guide](packages/auto-approval/README.md) and
[sandbox design](docs/adr/0008-sandbox-seam.md).

**Interface.** Light, dark and system themes share the sky palette; weather
symbols communicate agent state. `Ctrl+J` toggles the Workbench and
`` Ctrl+` `` opens the terminal. The desktop app shares the Web host's config and
Session data and keeps running in the system tray when its window is closed.

## Install and start

### Windows desktop

Download `Tnega-Setup-<version>.exe` from
[GitHub Releases](https://github.com/whale4rain/tnega/releases/latest), install it
and configure your model route and API key in **Settings**.

**Desktop 0.4.6 and later update inside the app.** It checks at startup and every
four hours, downloads a new release in the background and shows **Update** next
to Settings when ready. Click it to install and restart, or use **Settings →
Check for updates**. Users do not need to build or download each later installer.
Older clients need a one-time installation of an update-capable version.

### CLI and local Web

Requires **Node.js ≥22.19.0**.

```bash
npm install -g tnega
# or: pnpm add -g tnega
tnega web
# Open http://127.0.0.1:3080 and configure your model in Settings.
```

For a headless Agent Run:

```bash
export TNEGA_API_KEY=your-api-key
tnega run "Reply with: hello"
```

PowerShell uses `$env:TNEGA_API_KEY = 'your-api-key'`. The default route is
OpenCode Go's `deepseek-v4-flash` through an OpenAI-compatible endpoint;
`minimax-m3` is also available through Anthropic Messages. Configure your own
routes in Settings. Config is stored at `%USERPROFILE%\.tnega\config.json` on
Windows or `~/.config/tnega/config.json` on Linux/macOS. See the
[CLI guide](packages/cli/README.md) for model routes, environment variables and
flags.

Choose **Coding** for repository work, **Work** for Office files or **General**
for other tasks. Open **Projects** to start a sustained coordinator conversation
with shared Memory and a Library. See the [Project guide](docs/project/README.md).

```text
tnega run "prompt"                     # one Agent Run
tnega run --allow-shell "list files"   # opt into shell tools
tnega web                              # local Web interface
```

CLI upgrades use `npm install -g tnega@latest`; desktop self-update applies to
packaged desktop installations. Sessions use format v10; incompatible older
formats are rejected rather than migrated in place.

## Build on the harness

The npm package is also a TypeScript library. The root entry and domain
subpaths expose Context, Fiber, Agent, Session, Tools, LLM and capability seams.
Providers and consumers depend on a shared service definition; the composition
layer chooses the provider. Scoped disposal reverses registrations and effects.

Start with [core](packages/core/README.md), [agent](packages/agent/README.md),
[CLI/runtime](packages/cli/README.md) and the [domain vocabulary](CONTEXT.md).
The [ADRs](docs/adr/) describe persistence, sandboxing, approval, CodeMode and
browser tradeoffs. The former eval, evolve and benchmark packages were removed
in 0.4.6; see [ADR 0011](docs/adr/0011-remove-eval-first.md).

## Develop and release

```bash
pnpm install
pnpm tnega web --port 3080
pnpm --filter @tnega/web dev
```

Run the checks appropriate to your change: `pnpm test`, `pnpm typecheck`,
`pnpm lint` and `pnpm build`. Desktop development is documented in
[apps/desktop](apps/desktop/README.md); interface conventions are in the
[design guide](docs/design/tnega-design.md).

Read [docs/publish](docs/publish/README.md) before releasing. Maintainers build
and publish each new desktop version with its installer, blockmap and
`latest.yml` feed; installed clients consume that feed automatically. Keep
[CHANGELOG.md](CHANGELOG.md) and the version's [release notes](docs/releases/)
current.

## License

[MIT](LICENSE)

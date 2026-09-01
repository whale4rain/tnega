# Tnega

[中文](docs/zh-CN.md)

**Tnega** is "agent" spelled backwards. It is an eval-first agent harness with spacetime-composable plugin lifecycles: components can be hot-swapped and rolled back safely, and Eval is a first-class citizen on par with the agent loop and tools.

## Install

Requires Node.js >= 22.

```bash
npm install -g tnega
# or
pnpm add -g tnega
```

## Quick Start

```bash
export OPENCODE_GO_API_KEY=sk-...
tnega run "Reply with: hello"
```

`tnega run` uses OpenCode Go's `deepseek-v4-flash` model through the OpenAI compatible endpoint by default. `minimax-m3` is also available through the Anthropic Messages endpoint. The API key can also come from `~/.tnega/config.json` (Windows: `%USERPROFILE%\.tnega\config.json`) with fields `apiKey`, `model`, `baseUrl`, and `temperature`. Precedence: CLI flags > environment variables > config file > defaults.

Run a deterministic eval without an API key:

```bash
tnega eval run examples/tasks.yml
```

Start the local web UI:

```bash
tnega web
# http://127.0.0.1:3080
```

The web UI creates sessions as either `general` or `coding` agents. Coding
sessions support `auto` / `plan` / `execute` modes; plan mode shows the LLM
generated todo list above the composer and updates each item as tools mark it
done or failed. `/` slash commands such as `/mode`, `/skills`, and `/mcp` are
available in coding sessions.

## CLI

```text
tnega run "prompt"                       # one agent session
tnega run --allow-shell "list files"     # enable high-permission tools
tnega web                                # local web UI
tnega eval run tasks.yml                 # run evals
tnega eval compare <base> <head>         # compare two eval runs
tnega evolve run tasks.yml               # run a self-evolution loop
```

Options include `--model`, `--base-url`, `--max-tokens`, `--temperature`, `--cwd`, `--session`, `--timeout-ms`, `--max-retries`, and `--retry-delay-ms`. Sessions are recorded as JSONL under `.tnega/`.

## Built-in Tools

The default tool set is `echo`, `now`, `calculator`, `json`, `read_file`, `write_file`, `list_dir`, `glob`, and `grep`. High-permission tools are opt-in: `http_get` requires `--allow-network`, `shell` requires `--allow-shell`. File and shell tools are confined to the working directory.

## Coding Agent

`tnega/coding-agent` is a packaged agent plugin for workspace-oriented coding
sessions. It contributes plan generation, `plan_execute_mark` /
`plan_execute_result` tools, workspace skills (`skills_list` / `skill_read`),
stdio MCP servers from `.tnega/mcp.json`, and a slash command registry. The web
server enables it per session through `agentType: "coding"`, while general
sessions keep the default loop unchanged.

## Library

Tnega is published as a library as well as a CLI. Use the root package or domain subpaths (`tnega/core`, `tnega/agent`, `tnega/coding-agent`, `tnega/eval`, `tnega/evolve`, `tnega/session`, `tnega/tools`, `tnega/llm`, ...):

```ts
import { Context, defineAgent, openaiCompatAdapter } from 'tnega'

const root = new Context()
const fiber = await root.plugin(
  defineAgent({
    name: 'coding-agent',
    version: '0.1.1',
    system: 'You are a coding agent.',
  }),
  { llm: openaiCompatAdapter({ apiKey: process.env.OPENCODE_GO_API_KEY! }) },
)

const loop = root.get('agentLoop')
const result = await loop({ text: 'implement the feature' })
console.log(result.output)

await fiber.dispose()
```

## Concepts

- **Spacetime composability**: components can be inserted, replaced, and removed at runtime; effects are reversed in order on teardown, so hot-swaps leave no residue.
- **Eval as infrastructure**: strategies, tasks, evidence, verdicts, and runs are pluggable primitives, and evaluation is also the fitness function for self-evolution.
- **Self-evolution**: `evolve` proposes candidates, evaluates them in isolated scopes, and accepts or rejects them through deterministic gates.

See the [Chinese guide](docs/zh-CN.md) for the detailed design, model pricing table, library contracts, and roadmap.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## License

MIT

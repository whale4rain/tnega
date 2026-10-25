import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `--help` text for the executable and each of its commands. */

type Row = readonly [string, string]

const COLUMN = 26

function section(title: string, rows: readonly Row[]): string {
  return [title, ...rows.map(([name, text]) => `  ${name.padEnd(COLUMN)}${text}`)].join('\n')
}

const COMMANDS: readonly Row[] = [
  ['tnega [options]', 'open the terminal client here (same as tnega tui)'],
  ['tnega tui [options]', 'terminal client for this folder'],
  ['tnega web [options]', 'start the local web app'],
  ['tnega run "<prompt>"', 'run one prompt and print the answer'],
]

const CONFIG: Row = ['--config <file>', 'config file (default: ~/.tnega/config.json)']
const PROFILE: Row = ['--profile <name|file>', 'plugin profile to load']
const NO_PLUGINS: Row = ['--no-plugins', 'load no plugin profile']
const PLUGIN_DEV: Row = ['--plugin-dev', 'let the agent write plugins and patch them in live']
const HELP: Row = ['-h, --help', 'show this help']

const COMMAND_HELP: Record<string, { usage: string; summary: string; options: readonly Row[] }> = {
  tui: {
    usage: 'tnega tui [options]',
    summary: 'Terminal client for a folder. Starts the server in this process on a free\nlocal port; sessions also open in the web and desktop apps.',
    options: [
      ['--cwd <dir>', 'folder to work in (default: here)'],
      ['-c, --continue', 'reopen the latest session in this folder'],
      ['--session <id>', 'reopen a session by id'],
      ['--url <url>', 'attach to a running tnega server instead'],
      ['--port <port>', 'port for the server (default: any free port)'],
      CONFIG,
      PROFILE,
      NO_PLUGINS,
      PLUGIN_DEV,
      HELP,
    ],
  },
  web: {
    usage: 'tnega web [options]',
    summary: 'Start the local web app and print its address.',
    options: [
      ['--host <host>', 'address to listen on (default: 127.0.0.1)'],
      ['--port <port>', 'port to listen on'],
      CONFIG,
      PROFILE,
      NO_PLUGINS,
      PLUGIN_DEV,
      HELP,
    ],
  },
  run: {
    usage: 'tnega run "<prompt>" [options]',
    summary: 'Run one prompt in a folder and print the answer. For scripts and CI.',
    options: [
      ['--cwd <dir>', 'folder to work in (default: here)'],
      ['--session <file>', 'JSONL session file to continue'],
      CONFIG,
      ['--profile <name>', 'plugin profile to load'],
      ['--model <id>', 'model to use'],
      ['--base-url <url>', 'model API base URL'],
      ['--allow-shell', 'let the agent run shell commands'],
      ['--allow-network', 'let the agent use the network'],
      ['--max-turns <n>', 'stop after n turns'],
      ['--max-steps <n>', 'stop after n tool steps (default 64)'],
      ['--max-tokens <n>', 'output token limit per response'],
      ['--temperature <n>', 'sampling temperature'],
      ['--timeout-ms <n>', 'request timeout'],
      ['--max-retries <n>', 'retries for failed requests'],
      ['--retry-delay-ms <n>', 'delay between retries'],
      HELP,
    ],
  },
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg === '-h' || arg === '--help'
}

export function isVersionFlag(arg: string | undefined): boolean {
  return arg === '-v' || arg === '--version'
}

export function hasCommandHelp(command: string | undefined): boolean {
  return command !== undefined && command in COMMAND_HELP
}

export function mainHelp(): string {
  return [
    `tnega ${tnegaVersion()} · an agent harness that works in your folder`,
    '',
    section('Usage', COMMANDS),
    '',
    section('Options', [['-h, --help', 'show help; tnega <command> --help for its options'], ['-v, --version', 'print the version']]),
    '',
  ].join('\n')
}

export function commandHelp(command: string): string {
  const help = COMMAND_HELP[command]
  if (!help) return mainHelp()
  return [`Usage: ${help.usage}`, '', help.summary, '', section('Options', help.options), ''].join('\n')
}

let version: string | undefined

/** The version of the `tnega` package this executable belongs to. */
export function tnegaVersion(): string {
  if (version) return version
  // Source runs from packages/cli/src, the published build from dist/: walk up to the package.
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg && typeof pkg === 'object' && 'name' in pkg && pkg.name === 'tnega' && 'version' in pkg && typeof pkg.version === 'string') {
        version = pkg.version
        return version
      }
    } catch {
      // No package.json at this level.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  version = 'unknown'
  return version
}

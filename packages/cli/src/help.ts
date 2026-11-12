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
  ['tnega daemon [options]', 'serve this machine\'s files and commands to a server'],
  ['tnega server <command>', 'run or deploy a tnega server that several people sign in to'],
  ['tnega boxd [options]', 'run gVisor boxes for a server that is not root (as root)'],
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
  daemon: {
    usage: 'tnega daemon --server <url> [options]',
    summary: 'Serve folders on this machine to a tnega server, so its agents read files and\nrun commands here. Dials out over wss:// (ws:// only to this machine) and\nreconnects until stopped.',
    options: [
      ['--server <url>', 'the server to dial, wss://host/daemon'],
      ['--pair <code>', 'trade a code from tnega server pair --daemon for a token, kept in ~/.tnega/daemon.token'],
      ['--token <token>', 'device token (or set TNEGA_DAEMON_TOKEN; default: the saved one)'],
      ['--workspace <dir>', 'folder to serve; repeat for more (default: here)'],
      ['--device-id <id>', 'name this machine (default: from the host name)'],
      ['--browser', 'let the agent drive a browser here (its own profile, not yours)'],
      ['--computer', 'let the agent see and use the apps here; press p to pause'],
      HELP,
    ],
  },
  boxd: {
    usage: 'tnega boxd --workspace-root <dir> [options]',
    summary: 'The root helper of a gVisor box host. It alone runs runsc, ip, nft and\ncgroups; tnega server start runs as an ordinary user and reaches it through\nTNEGA_BOXD_SOCKET. It answers four requests (start, pause, stop, status).',
    options: [
      ['--workspace-root <dir>', 'folder whose subfolders boxes may mount; repeat for more'],
      ['--socket <path>', 'unix socket to listen on (default /run/tnega/boxd.sock)'],
      ['--group <name>', 'group that may connect (socket 0660); without it only root'],
      ['--state-dir <dir>', 'box records and bundles (default /var/lib/tnega/machines)'],
      ['--templates-dir <dir>', 'template root filesystems (default /var/lib/tnega/templates)'],
      ['--runsc-root <dir>', 'runsc state (default /run/tnega-runsc)'],
      ['--runsc <path>', 'the runsc binary (default runsc on PATH)'],
      ['--platform <name>', 'systrap (default), ptrace or kvm'],
      HELP,
    ],
  },
  server: {
    usage: 'tnega server <init|start|deploy|user|invite|pair> [options]',
    summary: 'A tnega server on Postgres that people sign in to. Settings are in\n~/.tnega/server/server.env (or --dir); the environment wins over the file.\n\n  init     write settings, create tables, print the first owner\'s invite\n  start    run the server; members work only in their own folder\n  deploy   write a Docker Compose setup (Postgres, server, HTTPS) and start it\n  user     list | add <login> | set <login> | passwd <login> | devices <login> | revoke <login> <id>\n  invite   print an invite link for a new person\n  pair     print a pairing code for <login>\'s client or --daemon',
    options: [
      ['--dir <dir>', 'settings folder (default: ~/.tnega/server)'],
      ['--database-url <url>', 'init: the Postgres database (or DATABASE_URL)'],
      ['--owner <login>', 'init: create the owner now (asks for a password)'],
      ['--host, --port', 'init / start: where to listen (default 127.0.0.1:8765)'],
      ['--public-url <url>', 'init: the address people open (for links)'],
      ['--trust-proxy', 'init: behind your own HTTPS proxy'],
      ['--domain <name>', 'deploy: get a certificate and serve HTTPS (Caddy)'],
      ['--no-start', 'deploy: write the files only'],
      ['--mirror <registry>', 'deploy: pull base images from here, not Docker Hub'],
      ['--npm-registry <url>', 'deploy: install tnega from this npm registry'],
      ['--apt-mirror <url>', 'deploy: Debian packages from this mirror'],
      ['--package <file.tgz>', 'deploy: install this packed tnega instead'],
      ['--role <role>', 'user / invite: owner, admin or member'],
      ['--password-stdin', 'read the password from stdin instead of asking'],
      ['--daemon', 'pair: a code for a daemon instead of a client'],
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
      ['--fs-guard=<mode>', 'overwriting a file changed since it was read: off, warn (default) or enforce'],
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

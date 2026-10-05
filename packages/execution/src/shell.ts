import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** Shell families with distinct syntax; the model is told which one it gets. */
export type SystemShellKind = 'bash' | 'zsh' | 'fish' | 'sh' | 'pwsh' | 'powershell' | 'cmd'

/**
 * The interpreter the `shell` tool runs commands with. Commands are always
 * passed as one argv element (or an encoded blob for PowerShell), so no
 * intermediate `cmd.exe` exists and no console window is created for it.
 */
export interface SystemShell {
  kind: SystemShellKind
  /** Absolute path or a name resolved through PATH. */
  path: string
  /** Display name for prompts and tool descriptions, e.g. `Git Bash`. */
  label: string
}

export interface ResolveShellOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Explicit shell path or name (config / `TNEGA_SHELL`); wins over detection. */
  preferred?: string
  /** Injected for tests. */
  exists?: (path: string) => boolean
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? ''
  return raw.split(platform === 'win32' ? ';' : ':').filter(Boolean)
}

function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (path: string) => boolean): string | undefined {
  const { join } = platform === 'win32' ? win32 : posix
  for (const dir of pathDirs(env, platform)) {
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** Classify a shell executable by its file name. */
export function shellKind(path: string): SystemShellKind {
  const name = posix.basename(path.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '')
  if (name === 'pwsh') return 'pwsh'
  if (name === 'powershell') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (name === 'zsh') return 'zsh'
  if (name === 'fish') return 'fish'
  if (name === 'bash') return 'bash'
  return 'sh'
}

function labelFor(kind: SystemShellKind, path: string): string {
  if (kind === 'bash' && /[\\/]git[\\/]/i.test(path)) return 'Git Bash'
  return {
    bash: 'bash', zsh: 'zsh', fish: 'fish', sh: 'sh',
    pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'cmd.exe',
  }[kind]
}

function shellAt(path: string): SystemShell {
  const kind = shellKind(path)
  return { kind, path, label: labelFor(kind, path) }
}

/** Git for Windows' `bin\bash.exe`, found next to `git.exe` on PATH or in the default install roots. */
function gitBash(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const { dirname, join } = win32
  const roots: string[] = []
  const git = onPath('git.exe', env, 'win32', exists)
  // <root>\cmd\git.exe or <root>\bin\git.exe or <root>\mingw64\bin\git.exe
  if (git) {
    let dir = dirname(git)
    for (let depth = 0; depth < 3; depth += 1) {
      roots.push(dir)
      dir = dirname(dir)
    }
  }
  for (const base of [env.ProgramFiles, env['ProgramW6432'], env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) roots.push(join(base, 'Git'))
  }
  for (const root of roots) {
    const candidate = join(root, 'bin', 'bash.exe')
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Pick the user's shell. Windows: PowerShell 7, then Windows PowerShell, then
 * Git Bash, then cmd. Elsewhere: `$SHELL`, then `/bin/sh`. An explicit
 * preference (path or bare name) wins when it can be found.
 */
export function resolveSystemShell(options: ResolveShellOptions = {}): SystemShell {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const preferred = (options.preferred ?? env.TNEGA_SHELL)?.trim()
  if (preferred) {
    if (exists(preferred)) return shellAt(preferred)
    // On Windows "bash" means Git Bash; System32\bash.exe is the WSL launcher,
    // which runs in Linux and sees none of the Windows paths the agent uses.
    if (platform === 'win32' && /^(git-?)?bash(\.exe)?$/i.test(preferred)) {
      const bash = gitBash(env, exists)
      if (bash) return shellAt(bash)
    } else {
      const named = platform === 'win32' && !/\.exe$/i.test(preferred) ? `${preferred}.exe` : preferred
      if (!/[\\/]/.test(named)) {
        const found = onPath(named, env, platform, exists)
        if (found) return shellAt(found)
      }
    }
  }
  if (platform === 'win32') {
    // PowerShell first: it is always present and, unlike MSYS/Cygwin bash, runs
    // under the Windows sandbox's restricted token.
    const pwsh = onPath('pwsh.exe', env, platform, exists)
    if (pwsh) return shellAt(pwsh)
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
    const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(powershell)) return shellAt(powershell)
    const bash = gitBash(env, exists)
    if (bash) return shellAt(bash)
    return shellAt(env.ComSpec ?? 'cmd.exe')
  }
  if (env.SHELL && exists(env.SHELL)) return shellAt(env.SHELL)
  return shellAt('/bin/sh')
}

/**
 * The argv that runs `command` in `shell`. PowerShell gets the command as
 * `-EncodedCommand` (UTF-16LE base64), so neither the Windows command line nor
 * PowerShell's own parser sees quotes it could misread.
 */
export function shellCommandArgv(shell: SystemShell, command: string): string[] {
  switch (shell.kind) {
    case 'pwsh':
    case 'powershell': {
      // UTF-8, ANSI-free output so captured text decodes like other shells
      // (the prelude stays on line 1 so error positions match the command's
      // own lines). Both settings fail quietly in ConstrainedLanguage mode,
      // which PowerShell enters under the read-only sandbox; `decodeOutput`
      // then reads the OEM code page instead. A failing last statement reports a native command's own
      // exit code rather than PowerShell's generic 1.
      // Progress records (module loading, npm) are serialized as a `#< CLIXML` block on
      // redirected stderr; nobody watches a progress bar here, so they are switched off.
      const prelude = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; '
        + '$OutputEncoding=[System.Text.Encoding]::UTF8; try { $PSStyle.OutputRendering=\'PlainText\' } catch {}; '
        + '$ProgressPreference=\'SilentlyContinue\'; '
      const script = `${prelude}${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`
      return [shell.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    }
    case 'cmd':
      return [shell.path, '/d', '/s', '/c', command]
    default:
      return [shell.path, '-c', command]
  }
}

/** MSYS/Cygwin bash needs named shared memory that a restricted token denies. */
export function isMsysShell(shell: SystemShell): boolean {
  return shell.kind === 'bash' && /[\\/](git|msys64|msys2|cygwin(64)?)[\\/]/i.test(shell.path)
}

/** One line for tool descriptions so the model writes commands in the right syntax. */
export function describeShell(shell: SystemShell): string {
  switch (shell.kind) {
    case 'pwsh':
    case 'powershell':
      return `Commands run in ${shell.label}; use PowerShell syntax (e.g. \`Get-ChildItem\`, \`;\` to chain, \`$env:NAME\`).`
    case 'cmd':
      return `Commands run in ${shell.label}; use cmd syntax (\`dir\`, \`&&\`, \`%NAME%\`).`
    default:
      return `Commands run in ${shell.label} (POSIX syntax${shell.label === 'Git Bash' ? '; Windows paths can be written as /c/Users/...' : ''}).`
  }
}

let cached: SystemShell | undefined
let preference: string | undefined

/** The process-wide default shell, resolved once per preference. */
export function systemShell(): SystemShell {
  return cached ??= resolveSystemShell(preference ? { preferred: preference } : {})
}

/**
 * Apply the user's shell choice (a name such as `pwsh` / `bash`, or a path);
 * empty means detect. Later `shell` calls, foreground or background, use it.
 */
export function configureSystemShell(preferred: string | undefined): SystemShell {
  const next = preferred?.trim() || undefined
  if (next !== preference) cached = undefined
  preference = next
  return systemShell()
}

/** The shells a user could pick on this machine, most preferred first. */
export function availableShells(options: Omit<ResolveShellOptions, 'preferred'> = {}): SystemShell[] {
  const platform = options.platform ?? process.platform
  const names = platform === 'win32' ? ['pwsh', 'powershell', 'bash', 'cmd'] : ['bash', 'zsh', 'fish', 'sh']
  const found = new Map<string, SystemShell>()
  for (const name of names) {
    const shell = resolveSystemShell({ ...options, preferred: name })
    // A preference that cannot be found falls back to detection; only keep real matches.
    if (shell.kind === shellKind(name)) found.set(shell.path.toLowerCase(), shell)
  }
  return [...found.values()]
}

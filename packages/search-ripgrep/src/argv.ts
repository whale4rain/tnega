export interface SearchCommandOptions {
  /** Search root as a workspace-relative path; defaults to the workspace itself. */
  path?: string
  /** Whether the workspace .gitignore filters the search. */
  respectGitignore: boolean
  /** Directory names pruned during traversal. */
  excludes: readonly string[]
}

/**
 * Shared ripgrep flags. `--no-config` is first: a host `RIPGREP_CONFIG_PATH`
 * can otherwise inject `--pre` and make ripgrep execute an arbitrary
 * preprocessor for every file it walks. `--no-require-git` extends .gitignore
 * honoring to workspaces that are not git repositories, which is otherwise
 * ripgrep's default gate. Each excluded name is negated with the bare
 * `!**\/<name>` form, which prunes the directory during traversal while
 * leaving an explicit search root inside that directory usable.
 */
function commonArgs(options: SearchCommandOptions): string[] {
  const args = ['--no-config', '--hidden']
  if (options.respectGitignore) args.push('--no-require-git')
  else args.push('--no-ignore')
  for (const name of options.excludes) args.push(`--glob=!**/${name}`)
  if (options.path !== undefined && options.path !== '.') args.push('--', options.path)
  return args
}

/** Build the `rg --files` argument vector for one file-discovery search. */
export function buildGlobArgv(pattern: string, options: SearchCommandOptions): string[] {
  const args = ['--files', `--glob=${pattern}`, '--sort=modified']
  return [...args, ...commonArgs(options)]
}

export interface GrepCommandOptions extends SearchCommandOptions {
  /** Optional file filter, e.g. `**\/*.md`. */
  glob?: string
}

/** Build the `rg --json` argument vector for one content search. */
export function buildGrepArgv(pattern: string, options: GrepCommandOptions): string[] {
  const args = ['--json', `--regexp=${pattern}`]
  if (options.glob !== undefined) args.push(`--glob=${options.glob}`)
  return [...args, ...commonArgs(options)]
}

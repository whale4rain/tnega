import { matchesRootOnly } from './glob.js'

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

/**
 * Pin a pattern to the search root.
 *
 * ripgrep's `--glob` follows gitignore semantics: a pattern WITHOUT a slash
 * matches a basename at ANY depth. A bare `*` therefore means "every file in
 * the tree", not "the search root's own entries", which turns the cheapest
 * request the model can make into a full traversal. A leading slash anchors
 * the pattern to the search root, which is the contract the tools document:
 * `*` stays within one segment, `**` crosses segments. Patterns that already
 * contain a slash (and negations, which are not patterns to match) are left
 * alone.
 */
export function anchorPattern(pattern: string): string {
  if (pattern.startsWith('!')) return pattern
  return pattern.includes('/') ? pattern : `/${pattern}`
}


/** Build the `rg --files` argument vector for one file-discovery search. */
export function buildGlobArgv(pattern: string, options: SearchCommandOptions): string[] {
  const args = ['--files', `--glob=${anchorPattern(pattern)}`, '--sort=modified']
  if (matchesRootOnly(pattern)) args.push('--max-depth', '1')
  return [...args, ...commonArgs(options)]
}

export interface GrepCommandOptions extends SearchCommandOptions {
  /** Optional file filter, e.g. `**\/*.md`. */
  glob?: string
}

/** Build the `rg --json` argument vector for one content search. */
export function buildGrepArgv(pattern: string, options: GrepCommandOptions): string[] {
  const args = ['--json', `--regexp=${pattern}`]
  if (options.glob !== undefined) {
    args.push(`--glob=${anchorPattern(options.glob)}`)
    if (matchesRootOnly(options.glob)) args.push('--max-depth', '1')
  }
  return [...args, ...commonArgs(options)]
}

/**
 * Build the `rg --files` argument vector that lists every file ripgrep would
 * search under the root, honouring ignore files. Used when `.gitignore` must
 * stay authoritative: the provider filters the list by pattern itself (see
 * `glob.ts`), because a positive `--glob` would override the ignore rules.
 */
export function buildListArgv(options: SearchCommandOptions & { rootOnly: boolean }): string[] {
  const args = ['--files', '--sort=modified']
  if (options.rootOnly) args.push('--max-depth', '1')
  return [...args, ...commonArgs(options)]
}

/**
 * Build the `rg --json` argument vector that searches an explicit list of
 * files, already filtered by the provider. No positive `--glob` is involved.
 */
export function buildGrepFilesArgv(pattern: string, files: readonly string[], options: SearchCommandOptions): string[] {
  return ['--json', `--regexp=${pattern}`, ...commonArgs({ respectGitignore: options.respectGitignore, excludes: options.excludes }), '--', ...files]
}

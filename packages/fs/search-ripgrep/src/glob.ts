/**
 * Glob matching done by the provider rather than by ripgrep.
 *
 * ripgrep's `--glob` is an *override*: a file matching a positive glob is
 * searched even when `.gitignore` excludes it. To keep ignore rules
 * authoritative, the provider lets ripgrep list the files it would search and
 * filters them here, with the same anchoring the tools document: patterns are
 * matched against paths relative to the search root, `*` and `?` stay within
 * one segment, `**` crosses segments, `{a,b}` alternates and `[...]` is a
 * character class.
 */

function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

function translate(pattern: string): string {
  let out = ''
  let braces = 0
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const atStart = index === 0 || pattern[index - 1] === '/'
        const next = pattern[index + 2]
        if (atStart && next === '/') {
          // `**/` — zero or more whole directories.
          out += '(?:[^/]*/)*'
          index += 2
        } else {
          out += '.*'
          index += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 2)
      if (close < 0) {
        out += '\\['
      } else {
        const body = pattern.slice(index + 1, close).replace(/^!/, '^').replaceAll('\\', '\\\\')
        out += `[${body}]`
        index = close
      }
    } else if (char === '{') {
      braces++
      out += '(?:'
    } else if (char === '}' && braces > 0) {
      braces--
      out += ')'
    } else if (char === ',' && braces > 0) {
      out += '|'
    } else {
      out += escapeLiteral(char)
    }
  }
  return out + ')'.repeat(braces)
}

/** A predicate over search-root-relative paths (forward slashes). */
export function globMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '')
  const expression = new RegExp(`^${translate(normalized)}$`)
  return path => expression.test(path)
}

/**
 * Whether a pattern can only ever match entries directly inside the search
 * root. Such a pattern needs no descent, and saying so is not just an
 * optimisation: without `--max-depth`, ripgrep keeps walking the whole tree —
 * `*` on a large workspace takes seconds to minutes and returns the same
 * handful of paths.
 */
export function matchesRootOnly(pattern: string): boolean {
  return !pattern.includes('/') && !pattern.includes('**')
}

/** Path of `path` (workspace-relative, as ripgrep prints it) relative to the search `root`. */
export function relativeToRoot(path: string, root: string): string {
  if (root === '.' || root === '') return path.replace(/^\.\//, '')
  const prefix = `${root.replace(/\/$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { SearchError } from '@tnega/search'

function isExecutable(path: string): boolean {
  try {
    if (process.platform === 'win32') return existsSync(path)
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve an executable name against `PATH`, honoring `PATHEXT` on Windows. */
function lookupOnPath(name: string): string | undefined {
  const searchPath = process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, name + extension.toLowerCase())
      if (isExecutable(candidate)) return candidate
      const upper = join(dir, name + extension.toUpperCase())
      if (upper !== candidate && isExecutable(upper)) return upper
    }
  }
  return undefined
}

const resolved = new Map<string, Promise<string>>()

/**
 * Resolve the ripgrep binary once per configured value: an explicit path wins,
 * otherwise `rg` is looked up on `PATH`. The promise is memoized so repeated
 * searches do not restat the filesystem.
 *
 * @throws SearchError `SEARCH_FAILED` when no usable binary can be resolved.
 */
export function resolveRipgrepPath(configured?: string): Promise<string> {
  const key = configured ?? ''
  let pending = resolved.get(key)
  if (!pending) {
    pending = Promise.resolve().then(() => {
      if (configured !== undefined) {
        if (!isExecutable(configured)) {
          throw new SearchError(
            `configured ripgrep binary is not executable: ${configured}`,
            'SEARCH_FAILED',
          )
        }
        return configured
      }
      const found = lookupOnPath('rg')
      if (!found) {
        throw new SearchError(
          'ripgrep (rg) was not found on PATH; install ripgrep or set the ripgrepPath option',
          'SEARCH_FAILED',
        )
      }
      return found
    })
    resolved.set(key, pending)
  }
  return pending
}

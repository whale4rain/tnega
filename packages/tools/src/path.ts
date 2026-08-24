import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class PathSandboxError extends Error {
  override name = 'PathSandboxError'
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === ''
    || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function resolveInside(cwd: string, input: string): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new PathSandboxError('path must be a non-empty string')
  }
  let root: string
  try {
    root = await realpath(cwd)
  } catch {
    throw new PathSandboxError(`workspace directory is not accessible: ${cwd}`)
  }
  const target = resolve(cwd, input)
  if (!inside(root, target)) {
    throw new PathSandboxError(`path escapes the workspace: ${input}`)
  }

  // Follow the deepest existing ancestor so a symlinked parent cannot escape.
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      if (!inside(root, real)) {
        throw new PathSandboxError(`path escapes the workspace through a symlink: ${input}`)
      }
      return target
    } catch (error) {
      if (!isMissing(error)) throw error
      const parent = dirname(current)
      if (parent === current) {
        throw new PathSandboxError(`path escapes the workspace: ${input}`)
      }
      current = parent
    }
  }
}

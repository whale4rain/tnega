import { realpathSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Handing a workspace file to the system (the renderer's right-click menu):
 * open it with the app registered for its type, or show it in the file
 * manager. The renderer names the file by workspace and workspace-relative
 * path; anything that resolves outside the workspace is refused.
 */

export type OpenFileResult = 'opened' | 'revealed' | 'missing' | 'failed'

/** The absolute path of `path` inside `workspace`, or undefined when it leaves it or does not exist. */
export function workspaceFile(workspace: unknown, path: unknown): string | undefined {
  if (typeof workspace !== 'string' || typeof path !== 'string' || !workspace || !path || !isAbsolute(workspace)) return undefined
  let root: string
  let target: string
  try {
    // Real paths, so a symlink inside the workspace cannot point the open outside it.
    root = realpathSync(resolve(workspace))
    target = realpathSync(resolve(root, path))
  } catch {
    return undefined
  }
  const inside = relative(root, target)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  return target
}

/**
 * Types the system would run rather than open. The agent can write these, so
 * "Open with default app" shows them in the file manager instead of starting them.
 */
const PROGRAMS: Readonly<Record<string, readonly string[]>> = {
  win32: ['exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'jar', 'reg', 'appref-ms'],
  darwin: ['app', 'command', 'tool', 'pkg', 'mpkg', 'terminal', 'workflow', 'jar'],
  linux: ['desktop', 'appimage', 'run', 'jar'],
}

export function launchesProgram(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const extension = extname(path).slice(1).toLowerCase()
  return Boolean(extension) && (PROGRAMS[platform] ?? PROGRAMS.linux ?? []).includes(extension)
}

export interface FileShell {
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

export async function openWorkspaceFile(shell: FileShell, workspace: unknown, path: unknown, platform: NodeJS.Platform = process.platform): Promise<OpenFileResult> {
  const target = workspaceFile(workspace, path)
  if (!target) return 'missing'
  if (launchesProgram(target, platform)) {
    shell.showItemInFolder(target)
    return 'revealed'
  }
  // `openPath` resolves to an error message, or '' when the system took the file.
  return (await shell.openPath(target)) ? 'failed' : 'opened'
}

export function revealWorkspaceFile(shell: FileShell, workspace: unknown, path: unknown): OpenFileResult {
  const target = workspaceFile(workspace, path)
  if (!target) return 'missing'
  shell.showItemInFolder(target)
  return 'revealed'
}

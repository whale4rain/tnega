/**
 * Bridge to the desktop app's file handoff (see apps/desktop/src/open-file.ts):
 * open a workspace file with the app the system uses for it (an editor for
 * code, the default browser for HTML), or show it in the file manager.
 * Absent in a plain web page.
 */

export type DesktopOpenResult = 'opened' | 'revealed' | 'missing' | 'failed'

export interface DesktopFilesBridge {
  open(workspace: string, path: string): Promise<DesktopOpenResult>
  reveal(workspace: string, path: string): Promise<DesktopOpenResult>
}

export function desktopFiles(): DesktopFilesBridge | undefined {
  const desktop: unknown = Reflect.get(globalThis, 'tnegaDesktop')
  if (!desktop || typeof desktop !== 'object') return undefined
  const files: unknown = Reflect.get(desktop, 'files')
  if (!files || typeof files !== 'object') return undefined
  const open: unknown = Reflect.get(files, 'open')
  const reveal: unknown = Reflect.get(files, 'reveal')
  if (typeof open !== 'function' || typeof reveal !== 'function') return undefined
  return {
    open: (workspace, path) => Promise.resolve(Reflect.apply(open, files, [workspace, path])).then(result),
    reveal: (workspace, path) => Promise.resolve(Reflect.apply(reveal, files, [workspace, path])).then(result),
  }
}

function result(value: unknown): DesktopOpenResult {
  return value === 'opened' || value === 'revealed' || value === 'missing' ? value : 'failed'
}

/** What the file manager is called where the app runs. */
export function fileManagerName(): string {
  const platform: unknown = Reflect.get(Reflect.get(globalThis, 'tnegaDesktop') ?? {}, 'platform')
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'Explorer'
  return 'folder'
}

import { request } from './api'

export interface DesktopApi {
  pickFolder(): Promise<string | undefined>
  revealWorkspace(path: string): Promise<void>
  version(): string
}

export interface DesktopGlobal {
  tnegaDesktop?: DesktopApi
}

function desktopGlobal(): DesktopGlobal {
  return globalThis as DesktopGlobal
}

export function hasDesktopFolderPicker(
  target: DesktopGlobal = desktopGlobal(),
): boolean {
  return typeof target.tnegaDesktop?.pickFolder === 'function'
}

export async function pickFolder(
  target: DesktopGlobal = desktopGlobal(),
): Promise<string | undefined> {
  const picker = target.tnegaDesktop?.pickFolder
  if (picker) return picker()
  const result = await request<{ path?: string }>('/api/folder-picker', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return result.path
}

export interface DesktopApi {
  pickWorkspace(): Promise<string | undefined>
  revealWorkspace(path: string): Promise<void>
  version(): string
  openSettings(): Promise<void>
}

export interface DesktopGlobal {
  tnegaDesktop?: DesktopApi
}

function desktopGlobal(): DesktopGlobal {
  return globalThis as DesktopGlobal
}

export function hasDesktopWorkspacePicker(
  target: DesktopGlobal = desktopGlobal(),
): boolean {
  return typeof target.tnegaDesktop?.pickWorkspace === 'function'
}

export async function pickDesktopWorkspace(
  target: DesktopGlobal = desktopGlobal(),
): Promise<string | undefined> {
  const picker = target.tnegaDesktop?.pickWorkspace
  if (!picker) return undefined
  return picker()
}

export function openSettingsWindow(target: DesktopGlobal = desktopGlobal()): void {
  if (target.tnegaDesktop?.openSettings) {
    void target.tnegaDesktop.openSettings()
    return
  }
  window.open('/?view=settings', 'tnega-settings', 'width=820,height=700')
}

export interface TnegaDesktopApi {
  pickWorkspace(): Promise<string | undefined>
  revealWorkspace(path: string): Promise<void>
  version(): string
}

declare global {
  interface Window {
    tnegaDesktop?: TnegaDesktopApi
  }
}

export {}

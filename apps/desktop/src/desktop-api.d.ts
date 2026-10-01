export interface TnegaDesktopApi {
  pickFolder(): Promise<string | undefined>
  revealWorkspace(path: string): Promise<void>
  version(): string
  /** Recolour the native window controls to match what the renderer draws behind them. */
  setTitleBarColors?(colors: { background: string, foreground: string }): void
}

declare global {
  interface Window {
    tnegaDesktop?: TnegaDesktopApi
  }
}

export {}

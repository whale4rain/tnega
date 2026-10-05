export interface TnegaDesktopApi {
  pickFolder(): Promise<string | undefined>
  revealWorkspace(path: string): Promise<void>
  version(): string
  /** Recolour the native window controls to match what the renderer draws behind them. */
  setTitleBarColors?(colors: { background: string, foreground: string }): void
  /** The agent's in-app browser, positioned over the renderer's Browser panel. */
  browser?: TnegaDesktopBrowserApi
  /** Self-update from GitHub releases (installed builds only). */
  updates?: TnegaDesktopUpdatesApi
}

export type TnegaDesktopUpdateState = { channel: 'stable' | 'preview' } & (
  | { status: 'unsupported'; version: string }
  | { status: 'idle'; version: string; checkedAt?: number }
  | { status: 'checking'; version: string }
  | { status: 'downloading'; version: string; next: string; percent: number }
  | { status: 'ready'; version: string; next: string }
  | { status: 'installing'; version: string; next: string }
  | { status: 'error'; version: string; message: string; checkedAt?: number }
)

export interface TnegaDesktopUpdatesApi {
  state(): Promise<TnegaDesktopUpdateState | undefined>
  check(): Promise<TnegaDesktopUpdateState | undefined>
  setChannel(channel: 'stable' | 'preview'): Promise<TnegaDesktopUpdateState | undefined>
  /** Shut the runtime down, install the downloaded version and relaunch. */
  install(): Promise<void>
  onState(listener: (state: TnegaDesktopUpdateState) => void): () => void
}

export interface TnegaDesktopBrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface TnegaDesktopBrowserApi {
  /** Where the native view sits, in CSS pixels of the window; `null` hides it. */
  setBounds(rect: { x: number, y: number, width: number, height: number } | null): void
  navigate(url: string): void
  command(command: 'back' | 'forward' | 'reload' | 'stop' | 'state'): void
  onState(listener: (state: TnegaDesktopBrowserState) => void): () => void
  /** The agent is about to use the browser: show the panel. */
  onReveal(listener: () => void): () => void
}

declare global {
  interface Window {
    tnegaDesktop?: TnegaDesktopApi
  }
}

export {}

import { contextBridge, ipcRenderer } from 'electron'

const desktopApi = Object.freeze({
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('tnega:pick-folder') as Promise<string | undefined>,
  revealWorkspace: (path: string): Promise<void> => ipcRenderer.invoke('tnega:reveal-workspace', path) as Promise<void>,
  version: (): string => ipcRenderer.sendSync('tnega:version') as string,
  updates: Object.freeze({
    state: (): Promise<unknown> => ipcRenderer.invoke('tnega:update-state'),
    check: (): Promise<unknown> => ipcRenderer.invoke('tnega:update-check'),
    install: (): Promise<void> => ipcRenderer.invoke('tnega:update-install') as Promise<void>,
    onState: (listener: (state: unknown) => void): (() => void) => {
      const handler = (_event: unknown, state: unknown) => listener(state)
      ipcRenderer.on('tnega:update-state', handler)
      return () => { ipcRenderer.removeListener('tnega:update-state', handler) }
    },
  }),
  setTitleBarColors: (colors: { background: string, foreground: string }): void => ipcRenderer.send('tnega:title-bar-colors', colors),
  browser: Object.freeze({
    setBounds: (rect: { x: number, y: number, width: number, height: number } | null): void => ipcRenderer.send('tnega:browser-bounds', rect),
    navigate: (url: string): void => ipcRenderer.send('tnega:browser-navigate', url),
    command: (command: 'back' | 'forward' | 'reload' | 'stop' | 'state'): void => ipcRenderer.send('tnega:browser-command', command),
    onState: (listener: (state: unknown) => void): (() => void) => {
      const handler = (_event: unknown, state: unknown) => listener(state)
      ipcRenderer.on('tnega:browser-state', handler)
      return () => { ipcRenderer.removeListener('tnega:browser-state', handler) }
    },
    onReveal: (listener: () => void): (() => void) => {
      const handler = () => listener()
      ipcRenderer.on('tnega:browser-reveal', handler)
      return () => { ipcRenderer.removeListener('tnega:browser-reveal', handler) }
    },
  }),
})

contextBridge.exposeInMainWorld('tnegaDesktop', desktopApi)

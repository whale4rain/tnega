import { contextBridge, ipcRenderer } from 'electron'

const desktopApi = Object.freeze({
  pickWorkspace: (): Promise<string | undefined> => ipcRenderer.invoke('tnega:pick-workspace') as Promise<string | undefined>,
  revealWorkspace: (path: string): Promise<void> => ipcRenderer.invoke('tnega:reveal-workspace', path) as Promise<void>,
  version: (): string => ipcRenderer.sendSync('tnega:version') as string,
  openSettings: (): Promise<void> => ipcRenderer.invoke('tnega:open-settings') as Promise<void>,
})

contextBridge.exposeInMainWorld('tnegaDesktop', desktopApi)

import { contextBridge, ipcRenderer } from 'electron'

const desktopApi = Object.freeze({
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('tnega:pick-folder') as Promise<string | undefined>,
  revealWorkspace: (path: string): Promise<void> => ipcRenderer.invoke('tnega:reveal-workspace', path) as Promise<void>,
  version: (): string => ipcRenderer.sendSync('tnega:version') as string,
})

contextBridge.exposeInMainWorld('tnegaDesktop', desktopApi)

import { createClient } from '@tnega/client/api'

export { ApiError, parseSseFrame } from '@tnega/client/api'
export type { BackgroundJob, BackgroundProcess, ConfigPatch, DirectoryEntry, SessionPatch, TextFile } from '@tnega/client/api'

/** Same-origin client: the page is served by the tnega server it talks to. */
const client = createClient()

export const api = {
  ...client.api,
  pickFolder: async (): Promise<string | undefined> => {
    const desktop = (globalThis as { tnegaDesktop?: { pickFolder?: () => Promise<string | undefined> } }).tnegaDesktop
    if (desktop?.pickFolder) return desktop.pickFolder()
    return (await client.api.folderPicker()).path
  },
}

export const fetchWorkspaceFile = client.fetchWorkspaceFile

/**
 * Start an Agent Run and feed each SSE frame to `onEvent` until the server
 * closes the stream. Aborting `signal` disconnects, which the server treats
 * as a user cancel.
 */
export const streamRun = client.streamRun

/** Save a fetched file through the browser's download flow. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

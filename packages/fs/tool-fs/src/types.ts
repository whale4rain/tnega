import type { ObservationStore } from './observed.js'

/** How strictly a write must match what this Agent has already read. */
export type FsGuardMode = 'off' | 'warn' | 'enforce'

/**
 * What the file tools need from the runtime they were composed into. Path
 * resolution (`resolve`) is the caller's, so the workspace fence stays in one
 * place: this package never decides what "inside the workspace" means.
 */
export interface FileToolsConfig {
  /** Absolute path for a workspace-relative path, or a rejection for an escape. */
  resolve(path: string): Promise<string>
  /** The path as the model wrote it, normalised for display. */
  displayPath(target: string): string
  /** Byte cap for one read's returned content. */
  maxReadBytes: number
  /** Byte cap for one write's content. */
  maxWriteBytes: number
  /** Lines one read returns unless it asks for fewer (and the most it may ask for). */
  maxReadLines: number
  /** Characters kept per line before it is clipped. */
  maxLineChars: number
  fsGuard: FsGuardMode
  /** What each Agent of this scope has read, for {@link fsGuard}. */
  observations: ObservationStore
}

/** Files above this size are read as a prefix; their hash is not recorded. */
export const READ_WHOLE_FILE_LIMIT = 8 * 1024 * 1024

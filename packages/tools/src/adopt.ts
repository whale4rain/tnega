import type { ProcessEntry } from '@tnega/execution'

/**
 * Execute option the jobs plugin passes to `shell` when the call asked for
 * `runInBackground`: instead of waiting for the command to exit, the tool starts it
 * as a background process in the workspace registry and hands the entry over.
 * Tools that accept it declare `metadata.backgroundProcess: true`.
 *
 * It lives with the tool vocabulary because two packages meet on it — the
 * shell tool that starts the process and the jobs plugin that owns it — and
 * neither depends on the other.
 */
export const ADOPT_BACKGROUND_PROCESS = 'adoptBackgroundProcess'

export interface AdoptedProcess {
  entry: ProcessEntry
  /** True when the registry outlives this runtime (the web server's per-workspace one). */
  shared: boolean
  /** Stop the process tree through the registry, so it reads as stopped rather than failed. */
  stop(): Promise<void>
}

export type AdoptBackgroundProcess = (process: AdoptedProcess) => void

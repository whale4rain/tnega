import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    memory: MemoryService
  }
}

export type MemoryScope = 'global' | 'project'

export const MAX_GLOBAL_MEMORY_CHARS = 4_000
export const MAX_PROJECT_MEMORY_CHARS = 4_000

export type MemoryErrorCode = 'MEMORY_INVALID' | 'MEMORY_FULL' | 'MEMORY_FAILED'

export class MemoryError extends Error {
  override name = 'MemoryError'

  constructor(message: string, readonly code: MemoryErrorCode, options?: ErrorOptions) {
    super(message, options)
  }
}

/** Persistent memory. The provider owns paths, size limits, and atomic writes. */
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  abstract read(scope: MemoryScope): Promise<string>

  /** Called only in response to an explicit user request to remember something. */
  abstract rememberGlobal(content: string): Promise<string>

  /** Replace the curated project notes after a successful compaction. */
  abstract writeProject(content: string): Promise<void>
}

export default MemoryService

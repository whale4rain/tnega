import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    subagents: SubagentService
  }
}

export type SubagentMode = 'spawn' | 'fork'
export type SubagentStatus = 'running' | 'idle' | 'ready' | 'failed'
export type SubagentAudience = 'agent' | 'user'

export interface SubagentStartRequest {
  parentId: string
  task: string
  label?: string
  mode?: SubagentMode
  audience?: SubagentAudience
  /** A job controller can deliver completion instead of the default parent report. */
  reportCompletion?: boolean
}

export interface SubagentEntry {
  id: string
  parentId: string
  label: string
  mode: SubagentMode
  audience: SubagentAudience
  status: SubagentStatus
  createdAt: number
  updatedAt: number
  depth: number
  lastOutput?: string
  resultChars?: number
  resultTruncated?: boolean
}

/** Character coordinates count Unicode code points, so pages never split surrogates. */
export interface SubagentResultRange {
  offset?: number
  limit?: number
}

export interface SubagentResultPage {
  output: string
  totalChars: number
  nextOffset: number | null
  status: SubagentStatus
}

export type SubagentScope = 'children' | 'descendants'

export class SubagentError extends Error {
  override name = 'SubagentError'
}

/** Delegation, adjacency checks, and durable child discovery. */
export abstract class SubagentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  abstract start(request: SubagentStartRequest): Promise<SubagentEntry>
  abstract send(senderId: string, recipientId: string, message: string): Promise<void>
  abstract list(parentId: string, scope?: SubagentScope): Promise<SubagentEntry[]>
  abstract readResult(parentId: string, id: string, range?: SubagentResultRange): Promise<SubagentResultPage>
}

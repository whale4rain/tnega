import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    subagents: SubagentService
  }
}

export type SubagentMode = 'spawn' | 'fork'
export type SubagentStatus = 'running' | 'idle' | 'ready' | 'failed'

export interface SubagentStartRequest {
  parentId: string
  task: string
  label?: string
  mode?: SubagentMode
}

export interface SubagentEntry {
  id: string
  parentId: string
  label: string
  mode: SubagentMode
  status: SubagentStatus
  createdAt: number
  updatedAt: number
  depth: number
  lastOutput?: string
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
}

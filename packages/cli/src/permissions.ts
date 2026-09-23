import { randomUUID } from 'node:crypto'
import { resolveInside, type ToolGuard, type ToolRequest } from '@tnega/tools'

export type PermissionMode = 'read-only' | 'workspace-write' | 'bypass'

const READ_TOOLS = new Set([
  'echo', 'now', 'calculator', 'json', 'read_file', 'list_dir',
  'glob', 'grep', 'http_get', 'web_search', 'skills_list', 'skill_read',
  'get_goal', 'update_goal', 'list_subagent', 'send_agent_message',
])

interface PendingApproval {
  key: string
  resolve: (allowed: boolean) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort: () => void
}

export class ApprovalBroker {
  private readonly runs = new Map<string, (event: Record<string, unknown>) => void>()
  private readonly pending = new Map<string, PendingApproval>()

  attach(key: string, emit: (event: Record<string, unknown>) => void): () => void {
    this.runs.set(key, emit)
    return () => {
      this.runs.delete(key)
      for (const [id, approval] of this.pending) {
        if (approval.key === key) this.settle(id, false)
      }
    }
  }

  decide(id: string, key: string, allow: boolean): boolean {
    if (this.pending.get(id)?.key !== key) return false
    this.settle(id, allow)
    return true
  }

  request(key: string, request: ToolRequest): Promise<boolean> {
    const emit = this.runs.get(key)
    if (!emit || request.options.signal?.aborted) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise(resolve => {
      const signal = request.options.signal
      const onAbort = (): void => this.settle(id, false)
      const timer = setTimeout(() => this.settle(id, false), 120_000)
      this.pending.set(id, {
        key, resolve, timer, onAbort, ...(signal ? { signal } : {}),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        emit({
          type: 'approval/request',
          id,
          tool: request.name,
          input: (JSON.stringify(request.input) ?? '').slice(0, 2_000),
        })
      } catch {
        this.settle(id, false)
      }
    })
  }

  private settle(id: string, allow: boolean): void {
    const approval = this.pending.get(id)
    if (!approval) return
    this.pending.delete(id)
    clearTimeout(approval.timer)
    approval.signal?.removeEventListener('abort', approval.onAbort)
    approval.resolve(allow)
  }
}

export function permissionGuard(
  mode: PermissionMode,
  key: string,
  approvals: ApprovalBroker,
  options: {
    workspace: string
    agentMode?: (agentId: string) => PermissionMode | undefined
  },
): ToolGuard {
  return async request => {
    const childMode = request.options.agentId ? options.agentMode?.(request.options.agentId) : undefined
    const rank = { 'read-only': 0, 'workspace-write': 1, bypass: 2 }
    const effective = childMode && rank[childMode] < rank[mode] ? childMode : mode
    if (effective === 'bypass') return undefined
    const unrestricted = mode === 'bypass'
    const pathKey = request.name === 'shell' ? 'cwd' : 'path'
    const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? request.input as Record<string, unknown> : {}
    const rawPath = typeof input[pathKey] === 'string' ? input[pathKey] : '.'
    let scoped = true
    if (unrestricted && ['read_file', 'write_file', 'list_dir', 'shell'].includes(request.name)) {
      try { await resolveInside(options.workspace, rawPath) } catch { scoped = false }
    }
    if (READ_TOOLS.has(request.name) && scoped
      && !(request.name === 'http_get' && unrestricted)) return undefined
    if (effective === 'workspace-write' && request.name === 'write_file' && scoped) return undefined
    const allowed = await approvals.request(key, request)
    if (allowed) request.options.approvedElevation = true
    return allowed ? undefined : `${request.name} requires human approval in ${effective} mode`
  }
}

import { randomUUID } from 'node:crypto'
import { resolveInside, type ToolGuard, type ToolRequest } from '@tnega/tools'
import { isLocalUrl, normalizeBrowserUrl } from '@tnega/browser'
import { BROWSER_OBSERVE_TOOLS } from '@tnega/tool-browser'
import type { ApprovalDecision } from '@tnega/approval-review'

export type PermissionMode = 'read-only' | 'workspace-write' | 'bypass'
export type PermissionModeSource = PermissionMode | (() => PermissionMode | Promise<PermissionMode>)

/**
 * 不需要逐次批准的调用：只读的工具，以及**只在 Project 内部发生**的动作。
 *
 * 后半类不碰这台机器：派工、线程间留言、给用户发言、写项目记忆与产物，都只改 Project
 * 自己的共享事实。它们造出来的 Agent 自己还要过同一道守卫，因此放行的半径由权限模型
 * 本身界定。真正需要用户点头的是越界与对外的动作 —— shell、工作区外的路径、网络。
 */
/** 与 `write_file` 同级：workspace-write 下在工作区内直接放行。 */
// Fixed user-home capability; callers cannot choose a destination path.
const SKILL_WRITES = new Set(['skill_create', 'skill_install'])
const WORKSPACE_WRITES = new Set(['write_file', 'office_create', 'office_edit'])

const ALWAYS_ALLOWED = new Set([
  // 只读
  'echo', 'now', 'calculator', 'json', 'read_file', 'list_dir',
  'glob', 'grep', 'http_get', 'web_search', 'skills_list', 'skill_read',
  'get_goal', 'update_goal', 'list_subagent', 'send_agent_message',
  'read_project', 'list_threads', 'read_artifact', 'office_inspect', 'office_read',
  // Project 内部
  'spawn_thread', 'send_thread_message', 'send_project_message', 'update_checklist',
  'create_routine', 'list_routines', 'update_routine',
  'write_memory', 'publish_artifact', 'index_resource',
  // 编排入口不自行执行宿主操作，子工具仍经过同一道守卫。
  'run_code', 'ask_user_question',
  'job_start', 'job_list', 'job_output', 'job_kill',
  // 只读或只作用于 Agent 自己启动的后台进程；启动本身（process_start）与 shell 同级。
  'process_output', 'process_list', 'process_stop',
])

/**
 * Browser tools that only move around or look: navigation is a GET like
 * `http_get`, and these never submit anything on their own.
 */
const BROWSER_PASSIVE = new Set([
  ...BROWSER_OBSERVE_TOOLS,
  'browser_navigate', 'browser_navigate_back', 'browser_reload',
  'browser_scroll', 'browser_hover', 'browser_wait_for', 'browser_resize', 'browser_tabs',
])

/**
 * Clicking, typing and running code on a local development page is ordinary
 * frontend work, at the same tier as editing workspace files. The same
 * interactions on any other site can submit forms or spend money, so they ask.
 */
function browserInteractionIsLocal(request: ToolRequest, pageUrl: string | undefined): boolean {
  if (!request.name.startsWith('browser_')) return false
  return pageUrl !== undefined && isLocalUrl(normalizeBrowserUrl(pageUrl))
}

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
  mode: PermissionModeSource,
  key: string,
  approvals: ApprovalBroker,
  options: {
    workspace: string
    agentMode?: (agentId: string) => PermissionMode | undefined
    review?: (request: ToolRequest) => Promise<ApprovalDecision | undefined>
    /** URL of the agent browser's current page, for the browser tool rules. */
    browserUrl?: () => string | undefined
  },
): ToolGuard {
  return async request => {
    const parentMode = typeof mode === 'function' ? await mode() : mode
    const childMode = request.options.agentId ? options.agentMode?.(request.options.agentId) : undefined
    const rank = { 'read-only': 0, 'workspace-write': 1, bypass: 2 }
    const effective = childMode && rank[childMode] < rank[parentMode] ? childMode : parentMode
    if (effective === 'bypass') return undefined
    const unrestricted = parentMode === 'bypass'
    const pathKey = request.name === 'shell' || request.name === 'process_start' ? 'cwd' : 'path'
    const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? request.input as Record<string, unknown> : {}
    const rawPath = typeof input[pathKey] === 'string' ? input[pathKey] : '.'
    let scoped = true
    if (unrestricted && ['read_file', 'write_file', 'list_dir', 'shell', 'process_start'].includes(request.name)) {
      try { await resolveInside(options.workspace, rawPath) } catch { scoped = false }
    }
    if (ALWAYS_ALLOWED.has(request.name) && scoped
      && !(request.name === 'http_get' && unrestricted)) return undefined
    if (effective === 'workspace-write' && SKILL_WRITES.has(request.name)) return undefined
    if (effective === 'workspace-write' && WORKSPACE_WRITES.has(request.name) && scoped) return undefined
    if (BROWSER_PASSIVE.has(request.name)) return undefined
    if (effective === 'workspace-write' && browserInteractionIsLocal(request, options.browserUrl?.())) return undefined
    if (request.options.signal?.aborted) return 'Tool approval cancelled'
    let reviewed: ApprovalDecision | undefined
    // A narrower child cannot use the parent's automatic elevation policy.
    if (!(childMode && rank[childMode] < rank[parentMode])) {
      try { reviewed = await options.review?.(request) } catch { /* Fall back to human approval. */ }
    }
    if (request.options.signal?.aborted) return 'Tool approval cancelled'
    if (typeof mode === 'function' && await mode() !== parentMode) return 'Tool permission changed during review'
    if (reviewed?.decision === 'deny') return `Automatic review denied ${request.name}: ${reviewed.reason}`
    const allowed = reviewed?.decision === 'allow' || await approvals.request(key, request)
    if (request.options.signal?.aborted) return 'Tool approval cancelled'
    if (typeof mode === 'function' && await mode() !== parentMode) return 'Tool permission changed during approval'
    if (allowed) request.options.approvedElevation = true
    return allowed ? undefined : `${request.name} requires human approval in ${effective} mode`
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlackboardError } from '@tnega/blackboard'
import { PROJECT_ID_PATTERN } from '@tnega/project'
import type { ProjectHost } from './project-host.js'

/** 路由层需要的宿主与 HTTP 工具；由 `server.ts` 提供，避免两处各写一套。 */
export interface ProjectRouteContext {
  /** 每个 workspace 一个宿主；由 server 缓存。 */
  host(workspace: string): Promise<ProjectHost>
  sendJson(res: ServerResponse, status: number, body: unknown): void
  sendError(res: ServerResponse, status: number, message: string): void
  readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>>
  writeSse(res: ServerResponse, data: unknown): void
  workspaceParam(url: URL): string | undefined
}

const PROJECT_PATH = /^\/api\/projects\/([^/]+)(\/.*)?$/

function isProjectId(value: string | undefined): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
}

/**
 * Project 的 HTTP 面。
 *
 * 读写都按 Project 作用域走：`GET …/:id` 给一份快照（主对话、Thread、记忆、Library），
 * `GET …/:id/stream` 给一条 SSE 变化流（信封、Thread 与记忆的提交、授权请求）。UI 不
 * 从模型文本里猜状态 —— 卡片读 Thread 记录，消息读 Box，执行细节读各 Agent 的 Session。
 */
export async function handleProjectApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: ProjectRouteContext,
): Promise<void> {
  const workspace = context.workspaceParam(url)
  if (!workspace) {
    context.sendError(res, 400, 'workspace query parameter is required')
    return
  }
  const host = await context.host(workspace)

  if (url.pathname === '/api/projects') {
    if (req.method === 'GET') {
      context.sendJson(res, 200, { workspace, projects: await host.list() })
      return
    }
    if (req.method === 'POST') {
      const body = await context.readJsonBody(req)
      if (typeof body.name !== 'string' || !body.name.trim()) {
        context.sendError(res, 400, 'name is required')
        return
      }
      const project = await host.create({
        name: body.name,
        ...(typeof body.goal === 'string' ? { goal: body.goal } : {}),
      })
      context.sendJson(res, 200, { project })
      return
    }
    context.sendError(res, 405, 'method not allowed')
    return
  }

  const match = PROJECT_PATH.exec(url.pathname)
  if (!match || !isProjectId(match[1])) {
    context.sendError(res, 400, 'a valid project id is required')
    return
  }
  const projectId = match[1]
  const rest = match[2] ?? ''

  if (rest === '' && req.method === 'GET') {
    context.sendJson(res, 200, await host.snapshot(projectId))
    return
  }

  if (rest === '/messages' && req.method === 'POST') {
    const body = await context.readJsonBody(req)
    if (typeof body.text !== 'string' || !body.text.trim()) {
      context.sendError(res, 400, 'text must be a non-empty string')
      return
    }
    const envelope = await host.sendUserMessage(projectId, body.text)
    // 发送成功的判据是信封落盘，不是模型回复。
    context.sendJson(res, 200, { messageId: envelope.messageId, createdAt: envelope.createdAt })
    return
  }

  const approval = /^\/approvals\/([^/]+)$/.exec(rest)
  if (approval && req.method === 'POST') {
    const body = await context.readJsonBody(req)
    if (typeof body.allow !== 'boolean') {
      context.sendError(res, 400, 'allow must be a boolean')
      return
    }
    const accepted = host.decide(projectId, approval[1]!, body.allow)
    if (!accepted) {
      context.sendError(res, 404, 'approval request is no longer pending')
      return
    }
    context.sendJson(res, 200, { accepted: true })
    return
  }

  const thread = /^\/threads\/([^/]+)(\/messages)?$/.exec(rest)
  if (thread) {
    const threadId = thread[1]!
    if (!isProjectId(threadId)) {
      context.sendError(res, 400, 'a valid thread id is required')
      return
    }
    if (!thread[2] && req.method === 'GET') {
      context.sendJson(res, 200, await host.thread(projectId, threadId))
      return
    }
    if (thread[2] && req.method === 'POST') {
      const body = await context.readJsonBody(req)
      if (typeof body.text !== 'string' || !body.text.trim()) {
        context.sendError(res, 400, 'text must be a non-empty string')
        return
      }
      const envelope = await host.sendThreadMessage(projectId, threadId, body.text)
      context.sendJson(res, 200, { messageId: envelope.messageId, createdAt: envelope.createdAt })
      return
    }
  }

  const memory = /^\/memory\/([^/]+)$/.exec(rest)
  if (memory) {
    const memoryId = memory[1]!
    if (!isProjectId(memoryId)) {
      context.sendError(res, 400, 'a valid memory id is required')
      return
    }
    if (req.method === 'GET') {
      context.sendJson(res, 200, { history: await host.memoryHistory(projectId, memoryId) })
      return
    }
    if (req.method === 'PATCH') {
      const body = await context.readJsonBody(req)
      const version = body.expected_version
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
        // 修改别人的记忆必须说明你读的是哪一版，否则就是一次静默覆盖。
        context.sendError(res, 400, 'expected_version is required to change project memory')
        return
      }
      const deleted = body.deleted === true
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!deleted && !text) {
        context.sendError(res, 400, 'text must be a non-empty string')
        return
      }
      try {
        const record = await host.writeMemory(projectId, {
          id: memoryId,
          text,
          expectedVersion: version,
          ...(deleted ? { deleted: true } : {}),
          ...(Array.isArray(body.tags)
            ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') }
            : {}),
        })
        context.sendJson(res, 200, { record })
      } catch (error) {
        if (error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') {
          context.sendJson(res, 409, {
            error: 'memory changed while you were editing it',
            current: error.current,
          })
          return
        }
        throw error
      }
      return
    }
  }

  if (rest === '/memory' && req.method === 'POST') {
    const body = await context.readJsonBody(req)
    if (typeof body.text !== 'string' || !body.text.trim()) {
      context.sendError(res, 400, 'text must be a non-empty string')
      return
    }
    const record = await host.writeMemory(projectId, {
      text: body.text.trim(),
      ...(Array.isArray(body.tags)
        ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') }
        : {}),
    })
    context.sendJson(res, 200, { record })
    return
  }

  if (rest === '/stream' && req.method === 'GET') {
    const afterParam = url.searchParams.get('after')
    const after = afterParam === null ? undefined : Number(afterParam)
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
      context.sendError(res, 400, 'after must be a non-negative integer')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const dispose = await host.watch(projectId, {
      ...(after !== undefined ? { after } : {}),
      send: event => {
        if (res.destroyed) return
        context.writeSse(res, event)
      },
    })
    res.once('close', dispose)
    return
  }

  context.sendError(res, 404, 'unknown project route')
}

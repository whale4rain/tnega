import { request } from '../api'
import type {
  BootEnvelope,
  FactRecord,
  ProjectRecord,
  ProjectSnapshot,
  ProjectStreamEvent,
  ThreadDetail,
} from './types'

function query(workspace: string): string {
  return `workspace=${encodeURIComponent(workspace)}`
}

export function listProjects(workspace: string): Promise<{ workspace: string; projects: ProjectRecord[] }> {
  return request(`/api/projects?${query(workspace)}`)
}

export function createProject(
  workspace: string,
  input: { name: string; goal?: string },
): Promise<{ project: ProjectRecord }> {
  return request(`/api/projects?${query(workspace)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getProject(workspace: string, id: string): Promise<ProjectSnapshot> {
  return request(`/api/projects/${id}?${query(workspace)}`)
}

export function getThread(
  workspace: string,
  id: string,
  threadId: string,
): Promise<ThreadDetail> {
  return request(`/api/projects/${id}/threads/${threadId}?${query(workspace)}`)
}

export function sendProjectMessage(
  workspace: string,
  id: string,
  text: string,
): Promise<{ messageId: string; createdAt: number }> {
  return request(`/api/projects/${id}/messages?${query(workspace)}`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function sendThreadMessage(
  workspace: string,
  id: string,
  threadId: string,
  text: string,
): Promise<{ messageId: string; createdAt: number }> {
  return request(`/api/projects/${id}/threads/${threadId}/messages?${query(workspace)}`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function decideApproval(
  workspace: string,
  id: string,
  approvalId: string,
  allow: boolean,
): Promise<{ accepted: boolean }> {
  return request(`/api/projects/${id}/approvals/${approvalId}?${query(workspace)}`, {
    method: 'POST',
    body: JSON.stringify({ allow }),
  })
}

/** 新增一条项目记忆。 */
export function addMemory(
  workspace: string,
  id: string,
  input: { text: string; tags?: string[] },
): Promise<{ record: FactRecord }> {
  return request(`/api/projects/${id}/memory?${query(workspace)}`, {
    method: 'POST',
    body: JSON.stringify({ text: input.text, ...(input.tags ? { tags: input.tags } : {}) }),
  })
}

/** 改动一条项目记忆：必须带上读到的版本号，否则服务端拒绝这次覆盖。 */
export function updateMemory(
  workspace: string,
  id: string,
  memoryId: string,
  input: { text: string; tags?: string[]; expectedVersion: number; deleted?: boolean },
): Promise<{ record: FactRecord }> {
  return request(`/api/projects/${id}/memory/${memoryId}?${query(workspace)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      text: input.text,
      expected_version: input.expectedVersion,
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.deleted ? { deleted: true } : {}),
    }),
  })
}

export function memoryHistory(
  workspace: string,
  id: string,
  memoryId: string,
): Promise<{ history: Array<FactRecord> }> {
  return request(`/api/projects/${id}/memory/${memoryId}?${query(workspace)}`)
}

/**
 * 订阅 Project 的变化流。
 *
 * 断线后按游标补齐：`after` 是这个会话已经见过的最后一条消息序号，服务端会先把之后的
 * 信封补发下来，再持续推送。返回一个中止函数。
 */
export function streamProject(
  workspace: string,
  id: string,
  options: {
    after?: number
    onEvent: (event: ProjectStreamEvent) => void
    onError?: (error: unknown) => void
    onClose?: () => void
  },
): () => void {
  const controller = new AbortController()
  const suffix = options.after === undefined ? '' : `&after=${options.after}`
  void (async () => {
    try {
      const response = await fetch(
        `/api/projects/${id}/stream?${query(workspace)}${suffix}`,
        { headers: { 'x-tnega-client': '1' }, signal: controller.signal },
      )
      if (!response.ok || !response.body) {
        throw new Error(`${response.status} ${response.statusText}`.trim())
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const data = frame.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          try {
            options.onEvent(JSON.parse(data) as ProjectStreamEvent)
          } catch {
            // 半截帧：丢掉它，下一帧继续。
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) options.onError?.(error)
    } finally {
      if (!controller.signal.aborted) options.onClose?.()
    }
  })()
  return () => controller.abort()
}

export type { BootEnvelope, ProjectRecord, ProjectSnapshot, ThreadDetail }

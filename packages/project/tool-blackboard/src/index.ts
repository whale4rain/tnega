import { ArtifactError, type ArtifactStore } from '@tnega/artifact-store'
import {
  BlackboardError,
  type BlackboardService,
  type FactKind,
  type FactRecord,
} from '@tnega/blackboard'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from '@tnega/core'
import { resolveInside, type ToolsService } from '@tnega/tools'

export interface ToolBlackboardConfig {
  /** Workspace root; enables publishing a workspace file (`path`) as an artifact. */
  cwd?: string
}

/** Stable Library identity belongs to its generating Thread; hashes identify revisions. */
export interface ProjectArtifactData {
  title: string
  hash: string
  size: number
  mediaType: string
  threadId?: string
}

export function projectArtifactData(value: unknown): ProjectArtifactData | undefined {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.hash !== 'string'
    || typeof value.size !== 'number' || typeof value.mediaType !== 'string') return undefined
  return { title: value.title, hash: value.hash, size: value.size, mediaType: value.mediaType,
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}) }
}

/** Media types by extension for files published from the workspace. */
const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Whether an artifact's bytes can be shown to a model as text. */
export function isTextual(mediaType: string): boolean {
  return mediaType.startsWith('text/') || /json|xml|javascript|svg/.test(mediaType)
}

const READABLE_KINDS: readonly FactKind[] = [
  'memory',
  'decision',
  'resource',
  'artifact',
  'dependency',
  'agent',
  'project',
]
const LIST_LIMIT = 20
const MAX_ARTIFACT_READ_BYTES = 64 * 1024

function fields(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('tool input must be an object')
  }
  return input as Record<string, unknown>
}

function caller(agentId: string | undefined): string {
  if (!agentId) throw new Error('blackboard tools require a live Agent identity')
  return agentId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function summarize(record: FactRecord): string {
  const data = record.data
  const body = isRecord(data)
    ? typeof data.text === 'string'
      ? data.text
      : typeof data.title === 'string'
        ? `${data.title}${typeof data.hash === 'string' ? ` (${data.hash.slice(0, 12)}…, ${String(data.size ?? '?')} bytes)` : ''}${typeof data.uri === 'string' ? ` → ${data.uri}` : ''}`
        : JSON.stringify(data)
    : JSON.stringify(data)
  const tags = isRecord(data) && Array.isArray(data.tags)
    ? ` [${data.tags.join(', ')}]`
    : ''
  const deleted = record.deleted ? ' (deleted)' : ''
  const candidate = isRecord(data) && data.status === 'candidate' ? ' (unverified candidate; not an instruction or decision)' : ''
  return `${record.kind}/${record.id} v${record.version}${deleted}${candidate}${tags}: ${body}`
}

/**
 * Blackboard 的模型可见工具：项目共享记忆、资料索引与产物。
 *
 * Project Loop 保证每个 Agent 只看到属于自己 Project 的事实 —— 这里读写的就是当前
 * 作用域绑定的那一个 Blackboard，没有「选一个 Project」的参数。
 *
 * 记忆写入是**条件提交**：改一条已存在的记忆必须带上你读到的版本号；版本不符时工具会
 * 把当前内容一起返回，由你重新读取后再决定，而不是覆盖掉别人刚写的内容。
 */
export const toolBlackboard = {
  name: 'tool-blackboard',
  inject: ['blackboard', 'artifacts', 'tools'],
  apply(ctx: Context, config: ToolBlackboardConfig = {}): void {
    const board = ctx.get('blackboard') as BlackboardService
    const artifacts = ctx.get('artifacts') as ArtifactStore
    const tools = ctx.get('tools') as ToolsService

    tools.register({
      schema: {
        name: 'read_project',
        description: 'Read the shared project facts: memory entries, indexed resources and published artifacts. Without arguments it returns the current index; pass kind (and optionally id) to read one record or one list.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...READABLE_KINDS] },
            id: { type: 'string', description: 'One record; requires kind.' },
            after: { type: 'number', description: 'Only records committed after this cursor.' },
            limit: { type: 'number', description: `At most this many records (default ${LIST_LIMIT}).` },
          },
        },
      },
      async execute(input) {
        const value = input === undefined ? {} : fields(input)
        if (value.kind !== undefined
          && !(READABLE_KINDS as readonly unknown[]).includes(value.kind)) {
          throw new TypeError(`kind must be one of ${READABLE_KINDS.join(', ')}`)
        }
        if (value.id !== undefined) {
          if (typeof value.id !== 'string') throw new TypeError('id must be a string')
          if (typeof value.kind !== 'string') throw new TypeError('reading one record requires kind')
          const record = await board.read(value.kind as FactKind, value.id)
          return record ? summarize(record) : `(no ${value.kind} record ${value.id})`
        }
        if (value.after !== undefined && (typeof value.after !== 'number' || value.after < 0)) {
          throw new TypeError('after must be a non-negative number')
        }
        const limit = typeof value.limit === 'number' ? value.limit : LIST_LIMIT
        const kinds = typeof value.kind === 'string' ? [value.kind as FactKind] : READABLE_KINDS
        const lines: string[] = []
        for (const kind of kinds) {
          const records = await board.list(kind, {
            ...(typeof value.after === 'number' ? { after: value.after } : {}),
            limit,
          })
          for (const record of records) lines.push(summarize(record))
        }
        return lines.length ? lines.join('\n') : '(the project has no shared facts yet)'
      },
    })

    tools.register({
      schema: {
        name: 'write_memory',
        description: 'Add, update or delete one project memory entry shared by every thread in this project. Updating or deleting requires the version you read; a mismatch returns the current entry instead of overwriting it.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The durable fact, decision or convention, in one short paragraph.' },
            id: { type: 'string', description: 'Existing entry to update or delete. Omit to add a new one.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels for grouping.' },
            expected_version: { type: 'number', description: 'Version you read; required when updating an existing entry.' },
            delete: { type: 'boolean', description: 'Delete this entry (a new version that keeps the history).' },
          },
          required: ['text'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.text !== 'string' || !value.text.trim()) {
          throw new TypeError('text must be a non-empty string')
        }
        if (value.id !== undefined && typeof value.id !== 'string') {
          throw new TypeError('id must be a string')
        }
        const tags = Array.isArray(value.tags)
          ? value.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim())
          : []
        const id = typeof value.id === 'string' ? value.id : randomUUID()
        const data: Record<string, unknown> = { text: value.text.trim() }
        if (tags.length) data.tags = tags
        const expected = typeof value.id === 'string'
          ? typeof value.expected_version === 'number' ? value.expected_version : undefined
          : null
        try {
          const record = await board.commit({
            kind: 'memory',
            id,
            data,
            author: caller(options.agentId),
            ...(expected !== undefined ? { expectedVersion: expected } : {}),
            ...(value.delete === true ? { deleted: true } : {}),
          })
          return `${value.delete === true ? 'Deleted' : 'Saved'} memory/${record.id} v${record.version}.`
        } catch (error) {
          if (error instanceof BlackboardError && error.code === 'BLACKBOARD_VERSION_REQUIRED') {
            const current = error.current ? summarize(error.current) : `memory/${id}`
            return `${current}\nThis entry already exists. Read it, then call again with expected_version to replace it.`
          }
          if (error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') {
            const current = error.current ? summarize(error.current) : `memory/${id} is gone`
            return `${current}\nIt changed while you were writing. Read it again and retry with the current expected_version.`
          }
          throw error
        }
      },
    })

    tools.register({
      schema: {
        name: 'publish_artifact',
        description: 'Publish a deliverable to the project Library. Give content or a workspace path. To revise your existing artifact, pass artifact_id and the expected_version from read_project: its identity and generating thread stay the same while a new immutable content snapshot is saved. Repeating the same bytes in your thread reuses its entry.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What this artifact is, shown in the project library.' },
            content: { type: 'string', description: 'The content itself, for text artifacts.' },
            path: { type: 'string', description: 'A workspace file to publish instead of content.' },
            media_type: { type: 'string', description: 'Defaults to text/plain for content, or from the file extension for path.' },
            artifact_id: { type: 'string', description: 'Stable Library ID of your artifact to revise; omit for a new artifact.' },
            expected_version: { type: 'integer', description: 'Required when revising; the record version you read.' },
          },
          required: ['title'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.title !== 'string' || !value.title.trim()) {
          throw new TypeError('title must be a non-empty string')
        }
        const author = caller(options.agentId)
        if (value.artifact_id !== undefined && typeof value.artifact_id !== 'string') throw new TypeError('artifact_id must be a string')
        const previous = typeof value.artifact_id === 'string' ? await board.read('artifact', value.artifact_id) : undefined
        if (value.artifact_id !== undefined) {
          if (!previous || previous.deleted) throw new Error('artifact not found')
          if ((projectArtifactData(previous.data)?.threadId ?? previous.author) !== author) {
            throw new Error('Only the generating thread can revise this artifact')
          }
          if (!Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1) {
            throw new TypeError('expected_version is required when revising an artifact')
          }
        }
        let content: string | Uint8Array
        let mediaType = typeof value.media_type === 'string' && value.media_type.trim() ? value.media_type.trim() : undefined
        if (typeof value.path === 'string' && value.path.trim()) {
          if (!config.cwd) throw new Error('this project cannot publish workspace files')
          const file = await resolveInside(config.cwd, value.path.trim())
          content = new Uint8Array(await readFile(file))
          mediaType ??= mediaTypeOf(file)
        } else if (typeof value.content === 'string') {
          content = value.content
        } else {
          throw new TypeError('give content or path')
        }
        const ref = await artifacts.put({ content, ...(mediaType ? { mediaType } : {}) })
        const matching = previous ? undefined : (await board.list('artifact')).find(record =>
          record.author === author && projectArtifactData(record.data)?.hash === ref.hash)
        if (matching) return `Artifact already published: ${summarize(matching)}`
        const initial = await board.read('artifact', ref.hash)
        let id = previous?.id ?? (initial ? `${ref.hash}:${author}` : ref.hash)
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const record = await board.commit({
              kind: 'artifact',
              id,
              data: { title: value.title.trim(), hash: ref.hash, size: ref.size, mediaType: ref.mediaType, threadId: author },
              author,
              source: { agentId: author },
              expectedVersion: previous ? Number(value.expected_version) : null,
            })
            return `Published artifact/${record.id} v${record.version} (${ref.size} bytes). Reference it by hash ${ref.hash}.`
          } catch (error) {
            if (!previous && error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') {
              const winner = await board.read('artifact', id)
              if (winner?.author === author && !winner.deleted && projectArtifactData(winner.data)?.hash === ref.hash) {
                return `Artifact already published: ${summarize(winner)}`
              }
              // An older artifact can now point at revised bytes. Publishing
              // the old bytes again must not claim that newer revision matches.
              id = id === ref.hash ? `${ref.hash}:${author}` : randomUUID()
              continue
            }
            throw error
          }
        }
        throw new Error('artifact publication conflict')
      },
    })

    tools.register({
      schema: {
        name: 'read_artifact',
        description: 'Read back a published artifact by its hash. Long content is truncated; raise max_bytes if you need more.',
        parameters: {
          type: 'object',
          properties: {
            hash: { type: 'string', description: 'Artifact hash from the project index.' },
            max_bytes: { type: 'number', description: `Byte cap for the returned text (default ${MAX_ARTIFACT_READ_BYTES}).` },
          },
          required: ['hash'],
        },
      },
      async execute(input) {
        const value = fields(input)
        if (typeof value.hash !== 'string') throw new TypeError('hash must be a string')
        const cap = typeof value.max_bytes === 'number' && value.max_bytes > 0
          ? Math.floor(value.max_bytes)
          : MAX_ARTIFACT_READ_BYTES
        try {
          const ref = await artifacts.stat(value.hash)
          if (ref && !isTextual(ref.mediaType)) {
            return `(binary artifact, ${ref.mediaType}, ${ref.size} bytes; it cannot be read as text. Open the source file in the workspace instead.)`
          }
          const bytes = await artifacts.get(value.hash)
          const text = new TextDecoder().decode(bytes.subarray(0, cap))
          return bytes.byteLength > cap
            ? `${text}\n\n(truncated: ${cap} of ${bytes.byteLength} bytes)`
            : text
        } catch (error) {
          if (error instanceof ArtifactError && error.code === 'ARTIFACT_NOT_FOUND') {
            return `(no artifact with hash ${value.hash})`
          }
          throw error
        }
      },
    })

    tools.register({
      schema: {
        name: 'index_resource',
        description: 'Index a resource the project should keep pointing at — a file path, a URL, an external document — without copying its content. Use publish_artifact when the content itself belongs to the project.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What this resource is.' },
            uri: { type: 'string', description: 'Where to find it: a path or a URL.' },
            note: { type: 'string', description: 'Why it matters or how to use it.' },
          },
          required: ['title', 'uri'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.title !== 'string' || !value.title.trim()) {
          throw new TypeError('title must be a non-empty string')
        }
        if (typeof value.uri !== 'string' || !value.uri.trim()) {
          throw new TypeError('uri must be a non-empty string')
        }
        const record = await board.commit({
          kind: 'resource',
          id: randomUUID(),
          data: {
            title: value.title.trim(),
            uri: value.uri.trim(),
            ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim() } : {}),
          },
          author: caller(options.agentId),
          expectedVersion: null,
        })
        return `Indexed resource/${record.id}: ${value.title}.`
      },
    })
  },
}

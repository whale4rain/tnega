import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BlackboardError, type BlackboardService, type FactRecord } from '@tnega/blackboard'
import type { Context } from '@tnega/core'
import {
  PROJECT_ID_PATTERN,
  ProjectError,
  ProjectsService,
  normalizeProjectName,
  type ProjectPatch,
  type ProjectRecord,
} from '@tnega/project'

export interface LocalProjectsConfig {
  /**
   * Project 目录集合，约定为 `<workspace>/.tnega/projects`。每个 Project 得到
   * `<root>/<projectId>/`，它自己的 Blackboard、Agent 文件夹和产物都在这个目录下。
   */
  root: string
  /** 没有显式署名时的默认作者，默认 `user`。 */
  author?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `project` 记录里存的东西：只有身份本身。`id` 由记录键提供，`createdAt` /
 * `updatedAt` 由缝的版本记录提供，因此不在 data 里重复一份。
 */
function toRecord(fact: FactRecord): ProjectRecord {
  const data = fact.data
  if (!isRecord(data) || typeof data.name !== 'string' || typeof data.coordinatorId !== 'string') {
    throw new ProjectError(`project record ${fact.id} is malformed`, 'PROJECT_FAILED')
  }
  const record: ProjectRecord = {
    id: fact.id,
    name: data.name,
    coordinatorId: data.coordinatorId,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  }
  if (typeof data.goal === 'string') record.goal = data.goal
  if (isRecord(data.repo) && typeof data.repo.path === 'string') {
    record.repo = {
      path: data.repo.path,
      ...(typeof data.repo.branch === 'string' ? { branch: data.repo.branch } : {}),
    }
  }
  return record
}

function toData(record: ProjectRecord): Record<string, unknown> {
  return {
    name: record.name,
    coordinatorId: record.coordinatorId,
    ...(record.goal !== undefined ? { goal: record.goal } : {}),
    ...(record.repo !== undefined ? { repo: record.repo } : {}),
  }
}

/**
 * 本地 Project Provider：身份存在 Blackboard 的 `project` kind 里，磁盘目录按
 * `<root>/<projectId>/` 建立。
 *
 * 取舍：
 *
 * - **身份只有一个真源**。`project` 记录是唯一权威；Provider 不另外维护
 *   `projects.json` 之类的索引文件，因此不存在两份列表需要同步。
 * - **只建目录，不预建子目录**。`blackboard/`、`agents/`、`artifacts/` 由各自的
 *   Provider 在第一次使用时创建 —— 一个还没用过的 Project 不该在磁盘上留下一堆空目录。
 * - **并发修改走条件提交**。`update` 先读当前版本再提交；期间被改过就以
 *   `ProjectError`（`PROJECT_FAILED`）拒绝，由调用者重新读取后重试，而不是覆盖。
 */
export class LocalProjectsService extends ProjectsService {
  private readonly root: string
  private readonly author: string
  private readonly board: BlackboardService

  constructor(ctx: Context, config: LocalProjectsConfig) {
    super(ctx)
    if (!config?.root || typeof config.root !== 'string') {
      throw new ProjectError('project-local requires a root directory', 'PROJECT_INVALID')
    }
    const board = ctx.get('blackboard') as BlackboardService | undefined
    if (!board) {
      throw new ProjectError(
        'project-local requires a Blackboard provider in the same scope',
        'PROJECT_FAILED',
      )
    }
    this.board = board
    this.root = resolve(config.root)
    this.author = config.author?.trim() || 'user'
  }

  override async create(input: { name: string; goal?: string }): Promise<ProjectRecord> {
    const name = normalizeProjectName(input?.name)
    const goal = input.goal?.trim()
    const id = randomUUID()
    const draft: ProjectRecord = {
      id,
      name,
      coordinatorId: randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(goal ? { goal } : {}),
    }
    await mkdir(this.directory(id), { recursive: true })
    const fact = await this.board.commit({
      kind: 'project',
      id,
      data: toData(draft),
      author: this.author,
      expectedVersion: null,
    })
    return toRecord(fact)
  }

  override async list(): Promise<ProjectRecord[]> {
    const facts = await this.board.list('project')
    return facts.map(toRecord).sort((a, b) => a.createdAt - b.createdAt)
  }

  override async get(id: string): Promise<ProjectRecord | undefined> {
    this.assertId(id)
    const fact = await this.board.read('project', id)
    if (!fact || fact.deleted) return undefined
    return toRecord(fact)
  }

  override async update(id: string, patch: ProjectPatch, author: string): Promise<ProjectRecord> {
    this.assertId(id)
    if (!patch || typeof patch !== 'object') {
      throw new ProjectError('project patch must be an object', 'PROJECT_INVALID')
    }
    const fact = await this.board.read('project', id)
    if (!fact || fact.deleted) {
      throw new ProjectError(`project not found: ${id}`, 'PROJECT_NOT_FOUND')
    }
    const next: ProjectRecord = { ...toRecord(fact), updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = normalizeProjectName(patch.name)
    if (patch.goal !== undefined) {
      if (patch.goal === null) delete next.goal
      else {
        const goal = patch.goal.trim()
        if (goal) next.goal = goal
        else delete next.goal
      }
    }
    if (patch.repo !== undefined) {
      if (patch.repo === null) delete next.repo
      else if (!patch.repo.path?.trim()) {
        throw new ProjectError('repo.path must be a non-empty string', 'PROJECT_INVALID')
      } else {
        next.repo = {
          path: patch.repo.path.trim(),
          ...(patch.repo.branch?.trim() ? { branch: patch.repo.branch.trim() } : {}),
        }
      }
    }
    try {
      const committed = await this.board.commit({
        kind: 'project',
        id,
        data: toData(next),
        author: author?.trim() || this.author,
        expectedVersion: fact.version,
      })
      return toRecord(committed)
    } catch (error) {
      if (error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') {
        throw new ProjectError(
          `project ${id} changed while it was being edited; reload and retry`,
          'PROJECT_FAILED',
          { cause: error },
        )
      }
      throw error
    }
  }

  override directory(id: string): string {
    this.assertId(id)
    return join(this.root, id)
  }

  private assertId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id)) {
      throw new ProjectError(`invalid project id: ${String(id)}`, 'PROJECT_INVALID')
    }
  }
}

export const projectLocal = {
  name: 'project-local',
  inject: ['blackboard'],
  apply(ctx: Context, config: LocalProjectsConfig): void {
    new LocalProjectsService(ctx, config)
  },
}

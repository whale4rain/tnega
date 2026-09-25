import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    projects: ProjectsService
  }
}

export type ProjectErrorCode = 'PROJECT_INVALID' | 'PROJECT_NOT_FOUND' | 'PROJECT_FAILED'

export class ProjectError extends Error {
  override name = 'ProjectError'

  constructor(
    message: string,
    readonly code: ProjectErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Project 身份。创建时只需要一个名称；仓库、资料和模型都是之后逐步补上的设置，
 * 不是创建的前置条件。
 *
 * `coordinatorId` 是**主对话那个 Thread 的稳定 ID**，在创建时铸定：协调 Agent 的
 * Session 文件夹由 Thread 缝在第一次打开时按这个 ID 建立，因此重新打开 Project
 * 永远回到同一个 Session，而不是新建一个。
 */
export interface ProjectRecord {
  id: string
  name: string
  goal?: string
  coordinatorId: string
  createdAt: number
  updatedAt: number
}

export interface ProjectPatch {
  name?: string
  goal?: string | null
}

export const MAX_PROJECT_NAME_CHARS = 200

export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function normalizeProjectName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new ProjectError('project name must be a string', 'PROJECT_INVALID')
  }
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('project name must not be empty', 'PROJECT_INVALID')
  if (trimmed.length > MAX_PROJECT_NAME_CHARS) {
    throw new ProjectError(
      `project name exceeds ${MAX_PROJECT_NAME_CHARS} characters`,
      'PROJECT_INVALID',
    )
  }
  return trimmed
}

/**
 * Project 身份与目录的 Service Definition：创建、列出、读取与修改 Project 本身。
 *
 * 契约：
 *
 * - **创建只需要名称**。除了名称（可选加一句初始目标），没有必填项；仓库、资料、
 *   模型和预算都是之后逐步补上的设置。
 * - **身份不是 Workspace**。一个 Project 有自己的 ID、自己的共享事实目录和自己的
 *   Agent 树；`Workspace`（见 `CONTEXT.md`）仍然是「一个绝对路径目录」，Project 不被
 *   它替代，也不与它等价。
 * - **这里不装运行时**。本缝只管身份与目录；Project 作用域里挂哪些 Provider 属于组合层。
 * - **不删除**。没有 `remove`：删掉用户数据不可逆，而产品里也没有删除 Project 的需求。
 *   需要停止使用时，不打开它即可。
 */
export abstract class ProjectsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'projects')
  }

  /** 在某个文件夹里建立 Project 身份与数据目录；同名 Project 允许存在。 */
  abstract create(input: { name: string; goal?: string }): Promise<ProjectRecord>

  /** 目录里的 Project，按创建时间升序。 */
  abstract list(): Promise<ProjectRecord[]>

  abstract get(id: string): Promise<ProjectRecord | undefined>

  /**
   * 修改身份或设置。`null` 表示清空该字段。
   *
   * @throws ProjectError 找不到 Project（`PROJECT_NOT_FOUND`）、补丁非法（`PROJECT_INVALID`）。
   */
  abstract update(id: string, patch: ProjectPatch, author: string): Promise<ProjectRecord>

  /** Project 的磁盘目录；Provider 决定它落在哪里。 */
  abstract directory(id: string): string
}

export default ProjectsService

/**
 * 最近打开的 Project。
 *
 * 和 Recent Workspace 一样由 Web UI 维护：Project 的文件夹可以是任意目录，不要求先被登记
 * 成 workspace，所以「这个浏览器之前打开过哪些 Project」这件事只有 UI 自己知道。
 */
export interface RecentProject {
  /** Project 所在的文件夹，也就是它的工作位置。 */
  workspace: string
  id: string
  name: string
  openedAt: number
}

const KEY = 'tnega-recent-projects'
const LIMIT = 30

export function readRecentProjects(storage: Storage): RecentProject[] {
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is RecentProject => {
      if (entry === null || typeof entry !== 'object') return false
      const value = entry as Record<string, unknown>
      return typeof value.workspace === 'string'
        && typeof value.id === 'string'
        && typeof value.name === 'string'
    }).map(entry => ({ ...entry, openedAt: entry.openedAt ?? 0 }))
  } catch {
    return []
  }
}

export function rememberProject(storage: Storage, project: Omit<RecentProject, 'openedAt'>): RecentProject[] {
  const next = [
    { ...project, openedAt: Date.now() },
    ...readRecentProjects(storage).filter(entry => !(entry.workspace === project.workspace && entry.id === project.id)),
  ].slice(0, LIMIT)
  storage.setItem(KEY, JSON.stringify(next))
  return next
}

export function forgetProject(storage: Storage, id: string): RecentProject[] {
  const next = readRecentProjects(storage).filter(entry => entry.id !== id)
  storage.setItem(KEY, JSON.stringify(next))
  return next
}

export function renameRecentProject(storage: Storage, id: string, name: string): RecentProject[] {
  const next = readRecentProjects(storage).map(entry => (entry.id === id ? { ...entry, name } : entry))
  storage.setItem(KEY, JSON.stringify(next))
  return next
}

/** 文件夹路径的尾段，用来在列表里区分同名 Project。 */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.at(-1) || path
}

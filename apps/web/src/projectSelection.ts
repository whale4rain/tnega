/** Project navigation entry. The sidebar rebuilds these from persisted Workspace Projects. */
export interface RecentProject {
  /** Project 所在的文件夹，也就是它的工作位置。 */
  workspace: string
  id: string
  name: string
  openedAt: number
  archived?: boolean
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
  const current = readRecentProjects(storage)
  const index = current.findIndex(entry => entry.workspace === project.workspace && entry.id === project.id)
  const timestamp = Date.now()
  const next = index < 0
    ? [...current, { ...project, openedAt: timestamp }]
    : current.map((entry, position) => position === index
      ? { ...entry, ...project, openedAt: timestamp }
      : entry)
  if (next.length > LIMIT) next.splice(0, next.length - LIMIT)
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

export function setRecentProjectArchived(storage: Storage, id: string, archived: boolean): RecentProject[] {
  const next = readRecentProjects(storage).map(entry => (entry.id === id ? { ...entry, archived } : entry))
  storage.setItem(KEY, JSON.stringify(next))
  return next
}

/** 文件夹路径的尾段，用来在列表里区分同名 Project。 */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.at(-1) || path
}

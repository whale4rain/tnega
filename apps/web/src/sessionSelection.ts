export interface SelectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const WORKSPACE_STORAGE_KEY = 'tnega-workspace'

const SESSION_MAP_STORAGE_KEY = 'tnega-session-selection'

export function readWorkspaceSelection(
  storage: SelectionStorage,
): string | null {
  return storage.getItem(WORKSPACE_STORAGE_KEY)
}

export function writeWorkspaceSelection(
  storage: SelectionStorage,
  workspace: string,
): void {
  storage.setItem(WORKSPACE_STORAGE_KEY, workspace)
}

export function resolveWorkspaceSelection(
  storage: SelectionStorage,
  available: string[],
): string | null {
  if (!available.length) return null
  const preferred = readWorkspaceSelection(storage)
  return preferred && available.includes(preferred)
    ? preferred
    : available[0]!
}

export function readSessionSelection(
  storage: SelectionStorage,
  workspace: string,
): string | null {
  const value = readSessionSelectionMap(storage)[workspace]
  return value ?? null
}

export function writeSessionSelection(
  storage: SelectionStorage,
  workspace: string,
  sessionId: string,
): void {
  const map = readSessionSelectionMap(storage)
  map[workspace] = sessionId
  storage.setItem(SESSION_MAP_STORAGE_KEY, JSON.stringify(map))
}

export function clearSessionSelection(
  storage: SelectionStorage,
  workspace: string,
): void {
  const map = readSessionSelectionMap(storage)
  delete map[workspace]
  storage.setItem(SESSION_MAP_STORAGE_KEY, JSON.stringify(map))
}

function readSessionSelectionMap(
  storage: SelectionStorage,
): Record<string, string> {
  const raw = storage.getItem(SESSION_MAP_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === 'string' && value) map[key] = value
    }
    return map
  } catch {
    return {}
  }
}

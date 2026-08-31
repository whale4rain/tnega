import { describe, expect, it } from 'vitest'
import {
  clearSessionSelection,
  readSessionSelection,
  readWorkspaceSelection,
  resolveWorkspaceSelection,
  writeSessionSelection,
  writeWorkspaceSelection,
  type SelectionStorage,
} from '../apps/web/src/sessionSelection.js'

function memoryStorage(
  initial: Record<string, string> = {},
): SelectionStorage & { entries(): Record<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return values.has(key) ? values.get(key)! : null
    },
    setItem(key, value) {
      values.set(key, value)
    },
    removeItem(key) {
      values.delete(key)
    },
    entries() {
      return Object.fromEntries(values)
    },
  }
}

describe('workspace selection persistence', () => {
  it('resolves the stored workspace when it is still available', () => {
    const storage = memoryStorage({ 'tnega-workspace': 'D:\\project-a' })
    expect(resolveWorkspaceSelection(storage, ['D:\\project-b', 'D:\\project-a']))
      .toBe('D:\\project-a')
  })

  it('falls back to the first available workspace when the stored one is gone', () => {
    const storage = memoryStorage({ 'tnega-workspace': 'D:\\gone' })
    expect(resolveWorkspaceSelection(storage, ['D:\\project-b']))
      .toBe('D:\\project-b')
  })

  it('returns null when no workspaces are available', () => {
    const storage = memoryStorage({ 'tnega-workspace': 'D:\\project-a' })
    expect(resolveWorkspaceSelection(storage, [])).toBeNull()
  })

  it('persists the selected workspace', () => {
    const storage = memoryStorage()
    writeWorkspaceSelection(storage, 'D:\\project-a')
    expect(readWorkspaceSelection(storage)).toBe('D:\\project-a')
  })
})

describe('session selection persistence', () => {
  it('stores the selected session per workspace', () => {
    const storage = memoryStorage()
    writeSessionSelection(storage, 'D:\\project-a', 'session-1')
    writeSessionSelection(storage, 'D:\\project-b', 'session-2')
    expect(readSessionSelection(storage, 'D:\\project-a')).toBe('session-1')
    expect(readSessionSelection(storage, 'D:\\project-b')).toBe('session-2')
    expect(readSessionSelection(storage, 'D:\\project-c')).toBeNull()
  })

  it('updates the selection when a new session is picked', () => {
    const storage = memoryStorage()
    writeSessionSelection(storage, 'D:\\project-a', 'session-1')
    writeSessionSelection(storage, 'D:\\project-a', 'session-2')
    expect(readSessionSelection(storage, 'D:\\project-a')).toBe('session-2')
  })

  it('clears only the requested workspace selection', () => {
    const storage = memoryStorage()
    writeSessionSelection(storage, 'D:\\project-a', 'session-1')
    writeSessionSelection(storage, 'D:\\project-b', 'session-2')
    clearSessionSelection(storage, 'D:\\project-a')
    expect(readSessionSelection(storage, 'D:\\project-a')).toBeNull()
    expect(readSessionSelection(storage, 'D:\\project-b')).toBe('session-2')
  })

  it('ignores corrupted selection data', () => {
    const storage = memoryStorage({ 'tnega-session-selection': '{oops' })
    expect(readSessionSelection(storage, 'D:\\project-a')).toBeNull()
    writeSessionSelection(storage, 'D:\\project-a', 'session-1')
    expect(readSessionSelection(storage, 'D:\\project-a')).toBe('session-1')
  })
})

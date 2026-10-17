import { mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { importLegacyFile, workspaceSessionDir, workspaceStateDir } from './home-paths.js'

/** Import runtime state without deleting the legacy backup or following symlinks. */
function importTree(source: string, target: string): void {
  let entries
  try {
    entries = readdirSync(source, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  mkdirSync(target, { recursive: true })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) importTree(from, to)
    else if (entry.isFile()) importLegacyFile(from, to)
    else throw new Error(`Cannot migrate non-regular runtime file: ${from}`)
  }
}

export function workspaceSubagentRoot(workspace: string): string {
  const target = join(workspaceSessionDir(workspace), 'subagents')
  importTree(join(resolve(workspace), '.tnega', 'subagents'), target)
  return target
}

/** Project messages and identities are runtime state; published artifacts stay in the workspace. */
export function workspaceProjectStateRoot(workspace: string): string {
  const legacy = join(resolve(workspace), '.tnega')
  const target = workspaceStateDir(workspace)
  importTree(join(legacy, 'blackboard'), join(target, 'blackboard'))
  let projects
  try {
    projects = readdirSync(join(legacy, 'projects'), { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return target
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const source = join(legacy, 'projects', project.name)
    const destination = join(target, 'projects', project.name)
    importTree(join(source, 'blackboard'), join(destination, 'blackboard'))
    const sessions = join(workspaceSessionDir(workspace), 'projects', project.name)
    importTree(join(source, 'agents'), join(sessions, 'agents'))
  }
  return target
}

export function projectSessionRoot(workspace: string, projectId: string): string {
  return join(workspaceSessionDir(workspace), 'projects', projectId)
}

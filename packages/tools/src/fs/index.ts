import { editFileTool } from './edit.js'
import { readFileTool } from './read.js'
import type { FileToolsConfig } from './types.js'
import { writeFileTool } from './write.js'
import type { ToolDefinition } from '../index.js'

export { editFileTool, readFileTool, writeFileTool }
export type { FileToolsConfig, FsGuardMode } from './types.js'
export { forgetObservations, observationOf } from './observed.js'
export { withPathLock } from './lock.js'

/** The file tools of one scope, in the order the model sees them. */
export function createFileTools(config: FileToolsConfig): ToolDefinition[] {
  return [readFileTool(config), writeFileTool(config), editFileTool(config)]
}

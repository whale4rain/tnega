import { stat } from 'node:fs/promises'
import { resolveInside } from '@tnega/fs-sandbox'
import { RpcError, RpcErrorCode, type DaemonWorkspace } from '@tnega/daemon-protocol'
import type { TerminalManager } from '@tnega/terminal-local'
import type { ExposedService } from './services.js'

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new RpcError(`${field} must be a string`, RpcErrorCode.INVALID_PARAMS)
  return value
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RpcError(`${field} must be a number`, RpcErrorCode.INVALID_PARAMS)
  return value
}

/**
 * `ctx.terminals` as the daemon serves it. A terminal opens only in a folder
 * inside a workspace this daemon announced; the id-based calls reach only
 * terminals this daemon made.
 */
export function exposeTerminals(manager: TerminalManager, workspaces: readonly DaemonWorkspace[]): ExposedService {
  const inside = async (path: string): Promise<string> => {
    for (const workspace of workspaces) {
      try {
        return await resolveInside(workspace.path, path)
      } catch {
        // Try the next workspace.
      }
    }
    throw new RpcError(`${path} is not inside a workspace this daemon serves`, RpcErrorCode.WORKSPACE_DENIED, { name: 'WorkspaceDeniedError', code: 'WORKSPACE_DENIED' })
  }
  return {
    calls: {
      list: async ([workspace]) => manager.list(workspace === undefined || workspace === null ? undefined : await inside(text(workspace, 'workspace'))),
      create: async ([workspace, size]) => {
        const cwd = await inside(text(workspace, 'workspace'))
        // A shell started in a missing folder dies at once with a chdir error; say why instead.
        if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) {
          throw new RpcError(`${text(workspace, 'workspace')} is not a folder`, RpcErrorCode.INVALID_PARAMS)
        }
        const shape = size !== null && typeof size === 'object' ? size as { cols?: unknown; rows?: unknown } : {}
        return await manager.create(cwd, {
          ...(typeof shape.cols === 'number' ? { cols: shape.cols } : {}),
          ...(typeof shape.rows === 'number' ? { rows: shape.rows } : {}),
        })
      },
      write: ([id, data]) => { manager.write(text(id, 'id'), text(data, 'data')); return null },
      resize: ([id, cols, rows]) => { manager.resize(text(id, 'id'), number(cols, 'cols'), number(rows, 'rows')); return null },
      close: ([id]) => { manager.close(text(id, 'id')); return null },
    },
    streams: {
      attach: ([id], emit) => manager.attach(text(id, 'id'), emit),
    },
  }
}

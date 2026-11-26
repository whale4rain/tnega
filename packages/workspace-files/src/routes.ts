import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@tnega/core'
import type { WorkspaceFs } from '@tnega/fs'
import type { ExecutionProvider } from '@tnega/process'
import { HttpError, readJsonBody, sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import { fileDiff, listChanges, localGit, type GitRunner } from './changes.js'
import { searchWorkspaceFiles, type FileListingMachine } from './file-search.js'
import { FileServeError, readWorkspaceFile, sendFile } from './files.js'
import { MAX_UPLOAD_BYTES, saveUpload } from './uploads.js'
import { MAX_TEXT_FILE_BYTES, listDirectory, readTextFile, writeTextFile } from './workspace-files.js'

/**
 * A workspace whose files are on another machine than this one (an E2B box
 * with its own volume). The Workbench reads them there, and runs git and
 * ripgrep there for the Changes view and the `@` file search.
 */
export interface WorkbenchMachine {
  fs: WorkspaceFs
  runProcess: ExecutionProvider['runProcess']
  /** A key for this machine in the file search's short cache. */
  key: string
  /** The machine's ripgrep. Default `rg`. */
  ripgrep?: string
  /** The largest file one request may move to or from the machine (a daemon's payload limit). */
  maxFileBytes?: number
  /** Called once the request is answered (a box lease ends). */
  release?(): void
}

export interface FileRoutesConfig {
  /**
   * The machine a workspace's files are on, asked per request. Undefined (or
   * no resolver) means this machine, fenced to the workspace as always. A
   * {@link FileServeError} it throws is the answer (the machine is asleep).
   */
  machine?: (workspace: string, req: IncomingMessage) => Promise<WorkbenchMachine | undefined>
}

/** What a request works on: the workspace's files and git, on whichever machine has them. */
interface Opened {
  fs: WorkspaceFs
  git: GitRunner
  listing?: FileListingMachine
  maxFileBytes?: number
}

/**
 * `git show` of a file's committed side, kept byte for byte: the process seam
 * carries text, so the box sends the bytes as base64 (a plain round trip
 * through UTF-8 would mangle any file that is not UTF-8).
 */
const SHOW_AS_BASE64 = 'f=$(mktemp) || exit 1; git "$@" > "$f"; s=$?; if [ "$s" -eq 0 ]; then base64 < "$f"; fi; rm -f "$f"; exit "$s"'

/** git through a machine's process call, as {@link localGit} runs it here. */
function machineGit(machine: WorkbenchMachine): GitRunner {
  return async (cwd, args) => {
    const show = args.includes('show')
    // The box is Linux whatever this host is, so sh and base64 are there.
    const argv = show ? ['sh', '-c', SHOW_AS_BASE64, 'git', ...args] : ['git', ...args]
    const result = await machine.runProcess({ argv, cwd, timeoutMs: 30_000, maxBuffer: 32 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git exited with ${result.exitCode}`)
    return show ? Buffer.from(result.stdout.trim(), 'base64') : Buffer.from(result.stdout, 'utf8')
  }
}

/** The workspace file browsing endpoints; this package owns what it serves. */
export const fileRoutes = {
  name: 'workspace-file-routes',
  inject: ['webServer', 'fs'],
  apply(ctx: Context, config: FileRoutesConfig = {}): void {
    const web = ctx.webServer
    // Always fenced: the Workbench never reaches outside the workspace it names.
    const open: Open = async (workspace, req, work) => {
      const machine = await config.machine?.(workspace, req)
      if (!machine) return await work({ fs: ctx.fs.workspace(workspace), git: localGit })
      try {
        return await work({
          fs: machine.fs,
          git: machineGit(machine),
          listing: { key: machine.key, runProcess: machine.runProcess, ripgrep: machine.ripgrep ?? 'rg' },
          ...(machine.maxFileBytes ? { maxFileBytes: machine.maxFileBytes } : {}),
        })
      } finally {
        machine.release?.()
      }
    }
    const changes = changesRoute(open)
    const tree = treeRoute(open)
    const text = textRoute(open)
    const file = fileRoute(open)
    const upload = uploadRoute(open)

    ctx.fiber.effect(() => web.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/files/search',
      handler: async (req, res, url) => {
        if (req.method !== 'GET') return
        const workspace = workspaceParam(url)
        if (!workspace) {
          sendError(res, 400, 'workspace query parameter is required')
          return
        }
        const limit = Number(url.searchParams.get('limit') ?? 30)
        try {
          const files = await open(workspace, req, ({ fs, listing }) =>
            searchWorkspaceFiles(listing ? fs.root : workspace, url.searchParams.get('q') ?? '', Number.isFinite(limit) ? limit : 30, listing))
          sendJson(res, 200, { files })
        } catch (error) {
          if (!(error instanceof FileServeError)) throw error
          sendError(res, error.status, error.message)
        }
      },
    }))

    for (const path of ['/api/changes', '/api/changes/file']) {
      ctx.fiber.effect(() => web.register({
        kind: 'exact',
        method: '*',
        path,
        handler: changes,
      }))
    }

    ctx.fiber.effect(() => web.register({
      kind: 'exact',
      method: '*',
      path: '/api/files/tree',
      handler: tree,
    }))
    ctx.fiber.effect(() => web.register({
      kind: 'exact',
      method: '*',
      path: '/api/files/text',
      handler: text,
    }))
    ctx.fiber.effect(() => web.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/files',
      handler: file,
    }))
    ctx.fiber.effect(() => web.register({
      kind: 'exact',
      method: 'POST',
      path: '/api/files/upload',
      handler: upload,
    }))
  },
}

type Open = <T>(workspace: string, req: IncomingMessage, work: (opened: Opened) => Promise<T>) => Promise<T>
type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>

const changesRoute = (open: Open): Handler => async (req, res, url) => {
  const workspace = workspaceParam(url)
  if (!workspace || req.method !== 'GET') {
    sendError(res, workspace ? 405 : 400, workspace ? 'method not allowed' : 'workspace query parameter is required')
    return
  }
  try {
    if (url.pathname === '/api/changes') {
      sendJson(res, 200, await open(workspace, req, ({ fs, git }) => listChanges(fs, git)))
    } else {
      const path = url.searchParams.get('path')
      if (!path) {
        sendError(res, 400, 'path query parameter is required')
        return
      }
      sendJson(res, 200, await open(workspace, req, ({ fs, git }) => fileDiff(fs, path, git)))
    }
  } catch (error) {
    if (!(error instanceof FileServeError)) throw error
    sendError(res, error.status, error.message)
  }
}

const treeRoute = (open: Open): Handler => async (req, res, url) => {
  const workspace = workspaceParam(url)
  if (!workspace) {
    sendError(res, 400, 'workspace query parameter is required')
    return
  }
  if (req.method !== 'GET') {
    sendError(res, 405, 'method not allowed')
    return
  }
  const path = url.searchParams.get('path') ?? ''
  try {
    sendJson(res, 200, { path, entries: await open(workspace, req, ({ fs }) => listDirectory(fs, path)) })
  } catch (error) {
    if (!(error instanceof FileServeError)) throw error
    sendError(res, error.status, error.message)
  }
}

const textRoute = (open: Open): Handler => async (req, res, url) => {
  const workspace = workspaceParam(url)
  const path = url.searchParams.get('path') ?? ''
  if (!workspace) {
    sendError(res, 400, 'workspace query parameter is required')
    return
  }
  if (!path) {
    sendError(res, 400, 'path query parameter is required')
    return
  }
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, await open(workspace, req, ({ fs }) => readTextFile(fs, path)))
      return
    }
    if (req.method !== 'PUT') {
      sendError(res, 405, 'method not allowed')
      return
    }
    const body = await readJsonBody(req, MAX_TEXT_FILE_BYTES * 2)
    if (typeof body.content !== 'string') {
      sendError(res, 400, 'content must be a string')
      return
    }
    const expected = typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined
    const content = body.content
    sendJson(res, 200, await open(workspace, req, ({ fs }) => writeTextFile(fs, path, content, expected)))
  } catch (error) {
    if (!(error instanceof FileServeError)) throw error
    sendError(res, error.status, error.message)
  }
}

const fileRoute = (open: Open): Handler => async (req, res, url) => {
  const workspace = workspaceParam(url)
  const path = url.searchParams.get('path')
  if (!workspace || !path) {
    sendError(res, 400, 'workspace and path query parameters are required')
    return
  }
  try {
    sendFile(res, await open(workspace, req, ({ fs, maxFileBytes }) => readWorkspaceFile(fs, path, maxFileBytes)))
  } catch (error) {
    if (!(error instanceof FileServeError)) throw error
    sendError(res, error.status, error.message)
  }
}

/**
 * A file dropped onto the message box. The body is JSON like every other
 * write to `/api` (the content-type check is what keeps other pages out), so
 * the bytes travel as base64: `{ name, data }`.
 */
const uploadRoute = (open: Open): Handler => async (req, res, url) => {
  const workspace = workspaceParam(url)
  if (!workspace) {
    sendError(res, 400, 'workspace query parameter is required')
    return
  }
  try {
    const body = await readJsonBody(req, Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 4096)
    if (typeof body.name !== 'string' || !body.name || typeof body.data !== 'string') {
      sendError(res, 400, 'name and data (base64) are required')
      return
    }
    const name = body.name
    const data = Buffer.from(body.data, 'base64')
    sendJson(res, 200, await open(workspace, req, ({ fs, maxFileBytes }) => saveUpload(fs, name, data, maxFileBytes)))
  } catch (error) {
    if (error instanceof FileServeError || error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    throw error
  }
}

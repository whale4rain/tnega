import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@tnega/core'
import { HttpError, readJsonBody, sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import { fileDiff, listChanges } from './changes.js'
import { searchWorkspaceFiles } from './file-search.js'
import { FileServeError, readWorkspaceFile, sendFile } from './files.js'
import { MAX_UPLOAD_BYTES, saveUpload } from './uploads.js'
import { MAX_TEXT_FILE_BYTES, listDirectory, readTextFile, writeTextFile } from './workspace-files.js'

/** The workspace file browsing endpoints; this package owns what it serves. */
export const fileRoutes = {
  name: 'workspace-file-routes',
  inject: ['webServer'],
  apply(ctx: Context): void {
    const web = ctx.webServer

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
        const files = await searchWorkspaceFiles(workspace, url.searchParams.get('q') ?? '', Number.isFinite(limit) ? limit : 30)
        sendJson(res, 200, { files })
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

async function changes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const workspace = workspaceParam(url)
  if (!workspace || req.method !== 'GET') {
    sendError(res, workspace ? 405 : 400, workspace ? 'method not allowed' : 'workspace query parameter is required')
    return
  }
  try {
    if (url.pathname === '/api/changes') {
      sendJson(res, 200, await listChanges(workspace))
    } else {
      const path = url.searchParams.get('path')
      if (!path) {
        sendError(res, 400, 'path query parameter is required')
        return
      }
      sendJson(res, 200, await fileDiff(workspace, path))
    }
  } catch (error) {
    if (!(error instanceof FileServeError)) throw error
    sendError(res, error.status, error.message)
  }
}

async function tree(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    sendJson(res, 200, { path, entries: await listDirectory(workspace, path) })
  } catch (error) {
    if (!(error instanceof FileServeError)) throw error
    sendError(res, error.status, error.message)
  }
}

async function text(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
      sendJson(res, 200, await readTextFile(workspace, path))
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
    sendJson(res, 200, await writeTextFile(workspace, path, body.content, expected))
  } catch (error) {
    if (!(error instanceof FileServeError)) throw error
    sendError(res, error.status, error.message)
  }
}

async function file(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const workspace = workspaceParam(url)
  const path = url.searchParams.get('path')
  if (!workspace || !path) {
    sendError(res, 400, 'workspace and path query parameters are required')
    return
  }
  try {
    sendFile(res, await readWorkspaceFile(workspace, path))
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
async function upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    sendJson(res, 200, await saveUpload(workspace, body.name, Buffer.from(body.data, 'base64')))
  } catch (error) {
    if (error instanceof FileServeError || error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    throw error
  }
}

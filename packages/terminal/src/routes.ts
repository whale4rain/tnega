import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@tnega/core'
import { readJsonBody, sendError, sendJson, workspaceParam, writeSse } from '@tnega/web-kit'
import { TerminalError, type TerminalEvent, type TerminalManager } from './index.js'

export interface TerminalRoutesConfig {
  terminals: TerminalManager
}

/** The Workbench terminal endpoints; the terminal package owns its stream shape. */
export const terminalRoutes = {
  name: 'terminal-routes',
  inject: ['webServer'],
  apply(ctx: Context, config: TerminalRoutesConfig): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'prefix',
      method: '*',
      path: '/api/terminals',
      handler: async (req, res, url) => {
        const match = url.pathname.match(/^\/api\/terminals(?:\/([^/]+)(?:\/(stream|input|resize))?)?$/)
        if (!match) {
          sendError(res, 404, 'not found')
          return
        }
        try {
          await handleTerminal(req, res, url, config.terminals, match[1], match[2])
        } catch (error) {
          if (!(error instanceof TerminalError)) throw error
          if (!res.headersSent) sendError(res, error.status, error.message)
        }
      },
    }))
  },
}

async function handleTerminal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  terminals: TerminalManager,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  if (!id) {
    const workspace = workspaceParam(url)
    if (req.method === 'GET') {
      sendJson(res, 200, { terminals: terminals.list(workspace ?? undefined) })
    } else if (req.method === 'POST') {
      if (!workspace) {
        sendError(res, 400, 'workspace query parameter is required')
        return
      }
      const body = await readJsonBody(req)
      sendJson(res, 200, await terminals.create(workspace, {
        ...(typeof body.cols === 'number' ? { cols: body.cols } : {}),
        ...(typeof body.rows === 'number' ? { rows: body.rows } : {}),
      }))
    } else {
      sendError(res, 405, 'method not allowed')
    }
    return
  }
  if (!action && req.method === 'DELETE') {
    terminals.close(id)
    sendJson(res, 200, { ok: true })
  } else if (action === 'stream' && req.method === 'GET') {
    const events: TerminalEvent[] = []
    // Attach first so an unknown id fails before the stream opens.
    let open = false
    const send = (event: TerminalEvent) => { if (!res.destroyed && !res.writableEnded) writeSse(res, event) }
    const detach = terminals.attach(id, event => { if (open) send(event); else events.push(event) })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    open = true
    for (const event of events) send(event)
    req.on('close', detach)
  } else if (action === 'input' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body.data !== 'string') {
      sendError(res, 400, 'data must be a string')
      return
    }
    terminals.write(id, body.data)
    sendJson(res, 200, { ok: true })
  } else if (action === 'resize' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
      sendError(res, 400, 'cols and rows must be numbers')
      return
    }
    terminals.resize(id, body.cols, body.rows)
    sendJson(res, 200, { ok: true })
  } else {
    sendError(res, 405, 'method not allowed')
  }
}

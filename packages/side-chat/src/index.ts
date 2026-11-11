import type { LLMAdapter } from '@tnega/agent'
import type { Context } from '@tnega/core'
import { deriveSurfaceMessages, type SessionEvent } from '@tnega/session'
import { SessionNotFoundError, isSessionId } from '@tnega/session-store'
import { errorMessage, HttpError, readJsonBody, sendError, workspaceParam, writeSse } from '@tnega/web-kit'
import { parseSideTurns, sideRequest } from './prompt.js'

export * from './prompt.js'

/** What a side question asks the host for: the model to answer it with. */
export interface SideChatModelRequest {
  workspace: string
  /** The session the question is about; its model answers unless `model` says otherwise. */
  session?: string
  /** A model route id the person picked. */
  model?: string
}

export interface SideChatConfig {
  /** The adapter that answers; the composition layer picks the route and its key. */
  resolveAdapter: (request: SideChatModelRequest) => Promise<LLMAdapter>
}

/** Frames of `POST /api/side-chat`. */
export type SideChatEvent =
  | { type: 'side/delta'; text: string }
  | { type: 'side/done'; finishReason: string }
  | { type: 'side/error'; message: string }

/** A side answer is a short reply; this covers it with room for hidden reasoning. */
const SIDE_MAX_TOKENS = 4096

/**
 * A temporary side chat (`/btw` and the sidebar's Temporary chat): one
 * question, optionally about a session, answered by the model without tools.
 * Nothing is written to any session and the running agent is not touched; the
 * client holds the side turns and sends them with each question.
 */
export const sideChatRoutes = {
  name: 'side-chat',
  inject: ['webServer', 'sessionStore'],
  apply(ctx: Context, config: SideChatConfig): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'POST',
      path: '/api/side-chat',
      handler: async (req, res, url) => {
        const workspace = workspaceParam(url)
        if (!workspace) return sendError(res, 400, 'workspace query parameter is required')
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendError(res, error instanceof HttpError ? error.status : 400, errorMessage(error))
        }
        const turns = parseSideTurns(body.messages)
        if (typeof turns === 'string') return sendError(res, 400, turns)
        const session = typeof body.session === 'string' && body.session ? body.session : undefined
        if (session !== undefined && !isSessionId(session)) return sendError(res, 400, 'invalid session id')
        const model = typeof body.model === 'string' && body.model ? body.model : undefined

        let about: { title?: string; messages: ReturnType<typeof deriveSurfaceMessages> } | undefined
        let adapter: LLMAdapter
        try {
          if (session) {
            const events: SessionEvent[] = []
            for await (const event of ctx.sessionStore.read(workspace, session)) events.push(event)
            const summary = await ctx.sessionStore.summary(workspace, session)
            about = { ...(summary.title ? { title: summary.title } : {}), messages: deriveSurfaceMessages(events) }
          }
          adapter = await config.resolveAdapter({ workspace, ...(session ? { session } : {}), ...(model ? { model } : {}) })
        } catch (error) {
          if (error instanceof SessionNotFoundError) return sendError(res, 404, 'session not found')
          return sendError(res, error instanceof HttpError ? error.status : 400, errorMessage(error))
        }

        const controller = new AbortController()
        res.on('close', () => { if (!res.writableEnded) controller.abort() })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        const send = (event: SideChatEvent) => { if (!res.destroyed) writeSse(res, event) }
        const messages = sideRequest(turns, about)
        const options = { maxTokens: SIDE_MAX_TOKENS, reasoning: 'off' as const, signal: controller.signal }
        try {
          if (adapter.stream) {
            let finishReason = 'stop'
            for await (const event of adapter.stream(messages, [], options)) {
              if (event.type === 'message_delta' && event.delta) send({ type: 'side/delta', text: event.delta })
              else if (event.type === 'message_stop') finishReason = event.finishReason
            }
            send({ type: 'side/done', finishReason })
          } else {
            const completion = await adapter.complete(messages, [], options)
            if (completion.content) send({ type: 'side/delta', text: completion.content })
            send({ type: 'side/done', finishReason: completion.finishReason })
          }
        } catch (error) {
          if (!controller.signal.aborted) send({ type: 'side/error', message: errorMessage(error) })
        } finally {
          res.end()
        }
      },
    }))
  },
}

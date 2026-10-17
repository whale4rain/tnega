import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_BODY_BYTES = 1024 * 1024

export class HttpError extends Error {
  override name = 'HttpError'

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maxBytes) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export function writeSse(res: ServerResponse, data: unknown): void {
  const value = JSON.stringify(data)
  const type = typeof data === 'object' && data !== null
    ? (data as { type?: unknown }).type
    : undefined
  const lines = [
    ...(typeof type === 'string' ? [`event: ${type}`] : []),
    `data: ${value}`,
    '',
    '',
  ]
  res.write(lines.join('\n'))
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

export function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** The `workspace` query parameter shared by the workspace-scoped endpoints. */
export function workspaceParam(url: URL): string | undefined {
  const value = url.searchParams.get('workspace')
  return value === null || !value.trim() ? undefined : value
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

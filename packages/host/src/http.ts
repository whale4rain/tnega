import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type {  IncomingMessage, ServerResponse  } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_BODY_BYTES = 1024 * 1024

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

export async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  webRoot: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'method not allowed')
    return
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = resolve(webRoot, relative)
  if (!filePath.startsWith(`${resolve(webRoot)}${sep}`) && filePath !== resolve(webRoot)) {
    sendError(res, 403, 'forbidden')
    return
  }
  let target = filePath
  try {
    const info = await stat(target)
    if (info.isDirectory()) target = join(target, 'index.html')
  } catch {
    target = join(webRoot, 'index.html')
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      sendError(res, 404, 'not found')
      return
    }
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': contentType(target),
      'content-length': body.byteLength,
      'cache-control': target.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=3600',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      sendError(res, 404, 'not found')
    } else {
      throw error
    }
  }
}

export function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.ico':
      return 'image/x-icon'
    case '.woff2':
      return 'font/woff2'
    case '.map':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function defaultWebRoot(): string {
  const candidates = [
    // Bundled package layout: dist/bin.js serves dist/web.
    new URL('../dist/web/', import.meta.url),
    // Source checkout layout: packages/host/src/server.ts serves <repo>/dist/web.
    new URL('../../../dist/web/', import.meta.url),
  ]
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    if (existsSync(path)) return path
  }
  return fileURLToPath(candidates[1]!)
}

export class HttpError extends Error {
  override name = 'HttpError'

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

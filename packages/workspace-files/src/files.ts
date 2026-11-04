import { extname } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { WorkspaceFs } from '@tnega/fs'

/**
 * `GET /api/files`：把工作区内的产物文件原样交给 Web 预览与下载。
 *
 * 只服务可预览的类型，路径经工作区的 `ctx.fs` 句柄限制在工作区内；与其它 API 一样
 * 要求 `x-tnega-client` 头，所以普通网页无法跨站读取。
 */
export const FILE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  // Images an agent sends in a reply (`send_file`); shown through <img>, which never runs an SVG's scripts.
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

export const MAX_SERVED_FILE_BYTES = 32 * 1024 * 1024

export class FileServeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface ServedFile {
  bytes: Buffer
  mediaType: string
}

export async function readWorkspaceFile(fs: WorkspaceFs, path: string): Promise<ServedFile> {
  const mediaType = FILE_MEDIA_TYPES[extname(path).slice(1).toLowerCase()]
  if (!mediaType) throw new FileServeError(`unsupported file type: ${path}`, 415)
  try {
    await fs.resolve(path)
  } catch (error) {
    if (!(error instanceof Error && error.name === 'PathSandboxError')) throw error
    throw new FileServeError(error.message, 400)
  }
  const info = await fs.stat(path).catch(() => undefined)
  if (info?.kind !== 'file') throw new FileServeError(`file not found: ${path}`, 404)
  if (info.size > MAX_SERVED_FILE_BYTES) throw new FileServeError(`file exceeds ${MAX_SERVED_FILE_BYTES} bytes`, 413)
  return { bytes: Buffer.from(await fs.readFile(path)), mediaType }
}

export function sendFile(res: ServerResponse, file: ServedFile): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(200, {
    'content-type': file.mediaType,
    'content-length': file.bytes.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(file.bytes)
}

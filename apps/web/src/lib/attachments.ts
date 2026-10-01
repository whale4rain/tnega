import type { ImageAttachment } from './types'

/** Longest edge sent to the model; larger images cost tokens without adding detail. */
export const MAX_IMAGE_EDGE = 1568
/** Images at or under this size and edge are sent as-is. */
const PASSTHROUGH_BYTES = 1_200_000
export const MAX_IMAGES_PER_MESSAGE = 8

const ACCEPTED: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function isAcceptedImage(file: { type: string }): boolean {
  return ACCEPTED.has(file.type)
}

export function imageSrc(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`
}

/** Fit `width × height` inside a square of `maxEdge`, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/**
 * Read a picked, pasted or dropped image into an attachment, downscaling and
 * re-encoding as JPEG when it is large. Returns undefined for other files.
 */
export async function imageFromFile(file: File): Promise<ImageAttachment | undefined> {
  if (!isAcceptedImage(file)) return undefined
  const bitmap = await createImageBitmap(file)
  try {
    const target = fitWithin(bitmap.width, bitmap.height)
    const name = file.name || undefined
    if (target.width === bitmap.width && file.size <= PASSTHROUGH_BYTES) {
      return {
        type: 'image',
        mediaType: file.type as ImageAttachment['mediaType'],
        data: base64FromBuffer(await file.arrayBuffer()),
        ...(name ? { name } : {}),
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (!context) return undefined
    // JPEG has no alpha; keep transparent screenshots legible.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, target.width, target.height)
    context.drawImage(bitmap, 0, 0, target.width, target.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86))
    if (!blob) return undefined
    return {
      type: 'image',
      mediaType: 'image/jpeg',
      data: base64FromBuffer(await blob.arrayBuffer()),
      ...(name ? { name } : {}),
    }
  } finally {
    bitmap.close()
  }
}

/** Image files from a paste or drop, in order. */
export function imageFiles(items: DataTransfer | null): File[] {
  if (!items) return []
  const files: File[] = []
  for (const file of Array.from(items.files)) if (isAcceptedImage(file)) files.push(file)
  if (files.length) return files
  for (const item of Array.from(items.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && isAcceptedImage(file)) files.push(file)
  }
  return files
}

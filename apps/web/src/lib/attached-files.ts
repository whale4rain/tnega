import { base64FromBuffer, isAcceptedImage } from './attachments'

/**
 * Files other than images that a person drops, pastes or picks into the
 * message box. Each one is saved into the workspace first, and the message
 * names it on a line of its own, `[Attached file: <path>]`, so the agent reads
 * it with its ordinary tools and the timeline can draw the line as a chip again.
 */

export const MAX_FILES_PER_MESSAGE = 10

const ATTACHED = /^\[Attached file: (.+)\]$/u

export function attachedFileLine(path: string): string {
  return `[Attached file: ${path}]`
}

/** The last segment of a `/`- or `\`-separated path. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * Split a sent message into the attached-file lines it starts with and the
 * rest, the person's own words.
 */
export function splitAttachedFiles(message: string): { paths: string[]; rest: string } {
  const blocks = message.split(/\n{2,}/u)
  const paths: string[] = []
  while (blocks.length) {
    const lines = blocks[0]!.split('\n')
    const matches = lines.map(line => ATTACHED.exec(line.trim())?.[1])
    if (!matches.every((path): path is string => Boolean(path))) break
    paths.push(...matches)
    blocks.shift()
  }
  return { paths, rest: blocks.join('\n\n') }
}

/** Every file in a drop or paste, in order. */
export function droppedFiles(items: DataTransfer | null): File[] {
  if (!items) return []
  const files = Array.from(items.files)
  if (files.length) return files
  const found: File[] = []
  for (const item of Array.from(items.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) found.push(file)
  }
  return found
}

/**
 * Which of the dropped files go in as images (shown to the model) and which
 * are saved as files. Without image support every file is saved.
 */
export function sortDropped(files: readonly File[], acceptImages: boolean): { images: File[]; others: File[] } {
  const images: File[] = []
  const others: File[] = []
  for (const file of files) (acceptImages && isAcceptedImage(file) ? images : others).push(file)
  return { images, others }
}

export async function base64FromFile(file: Blob): Promise<string> {
  return base64FromBuffer(await file.arrayBuffer())
}

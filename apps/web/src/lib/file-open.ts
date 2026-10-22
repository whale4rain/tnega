import { officeKind } from './office'

/**
 * Where a workspace file opens when you click it in a session:
 * - `page`: HTML, shown in the Workbench browser (relative CSS, scripts and
 *   images load as they would from disk);
 * - `markdown`: rendered in Files, with a switch back to the source;
 * - `preview`: office documents, PDFs and images, in a preview tab;
 * - `text`: anything else, in the Files editor.
 */
export type FileOpenKind = 'page' | 'markdown' | 'preview' | 'text'

export function fileOpenKind(path: string): FileOpenKind {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (extension === 'html' || extension === 'htm') return 'page'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (officeKind(path) || extension === 'pdf' || extension === 'png' || extension === 'jpg' || extension === 'jpeg') return 'preview'
  return 'text'
}

/**
 * `file:///` URL of a workspace-relative path. Works for POSIX roots
 * (`/home/me/site`) and Windows roots (`C:\Users\me\site`); each segment is
 * percent-encoded so spaces, `#` and `?` in names survive.
 */
export function fileUrl(workspace: string, path: string): string {
  const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = [...root.split('/'), ...path.replace(/\\/g, '/').split('/')].filter(Boolean)
  const encoded = segments.map((segment, index) => index === 0 && /^[a-z]:$/i.test(segment) ? segment.toUpperCase() : encodeURIComponent(segment))
  return `file:///${encoded.join('/')}`
}

/** The absolute path of a workspace-relative path, in the workspace's own separator style. */
export function absolutePath(workspace: string, path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(workspace) || workspace.startsWith('\\\\')
  const separator = windows ? '\\' : '/'
  const root = workspace.replace(/[\\/]+$/, '')
  return `${root}${separator}${path.replace(/[\\/]/g, separator)}`
}

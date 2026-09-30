import type { Block, ToolView } from './timeline'

export type OfficeKind = 'xlsx' | 'docx' | 'pptx'

export interface OfficeFile {
  path: string
  kind: OfficeKind
}

const WRITERS = new Set(['office_create', 'office_edit'])

export function officeKind(path: string): OfficeKind | undefined {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension === 'xlsx' || extension === 'docx' || extension === 'pptx' ? extension : undefined
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

function writtenPath(tool: ToolView): string | undefined {
  if (!WRITERS.has(tool.name) || tool.status !== 'ok') return undefined
  const output = tool.output
  if (!output || typeof output !== 'object' || !('path' in output)) return undefined
  return typeof output.path === 'string' ? output.path : undefined
}

/**
 * 一轮里产出的 Office 文件：成功的 `office_create` / `office_edit`（含 CodeMode 内的子调用）。
 * 同一路径只列一次，按最后一次写入的顺序排列。
 */
export function officeFiles(blocks: readonly Block[]): OfficeFile[] {
  const paths: string[] = []
  const visit = (tool: ToolView): void => {
    const path = writtenPath(tool)
    if (path) {
      const index = paths.indexOf(path)
      if (index >= 0) paths.splice(index, 1)
      paths.push(path)
    }
    tool.children?.forEach(visit)
  }
  for (const block of blocks) if (block.kind === 'tool') visit(block.tool)
  return paths.flatMap(path => {
    const kind = officeKind(path)
    return kind ? [{ path, kind }] : []
  })
}

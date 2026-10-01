import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, sep } from 'node:path'
import type { Context } from '@tnega/core'
import {
  createDocument,
  createPresentation,
  createWorkbook,
  editWorkbook,
  inspectDocument,
  inspectPresentation,
  inspectWorkbook,
  readDocument,
  readPresentation,
  readRange,
} from '@tnega/office'
import { ToolInputError, resolveInside, type ToolDefinition, type ToolsService } from '@tnega/tools'
import {
  documentSpec,
  optionalBoolean,
  optionalNumber,
  optionalString,
  presentationSpec,
  record,
  stringField,
  workbookOps,
  workbookSpec,
} from './input.js'

export type OfficeKind = 'xlsx' | 'docx' | 'pptx'

export const OFFICE_MEDIA_TYPES: Readonly<Record<OfficeKind, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export interface ToolOfficeConfig {
  /** 工作区根；所有路径都限制在其内。 */
  cwd?: string
  /** 可读取的最大文件字节数。 */
  maxReadBytes?: number
  disabled?: readonly string[]
}

interface ResolvedConfig {
  cwd: string
  maxReadBytes: number
  disabled: ReadonlySet<string>
}

export const DEFAULT_MAX_OFFICE_BYTES = 32 * 1024 * 1024
const TIMEOUT_MS = 60_000

export const DEFAULT_TOOL_OFFICE_NAMES: readonly string[] = ['office_inspect', 'office_read', 'office_create', 'office_edit']

function kindOf(path: string): OfficeKind {
  const extension = extname(path).slice(1).toLowerCase()
  if (extension === 'xlsx' || extension === 'docx' || extension === 'pptx') return extension
  throw new ToolInputError(`unsupported office file type: ${path} (expected .xlsx, .docx or .pptx)`)
}

function displayPath(cwd: string, target: string): string {
  return relative(cwd, target).split(sep).join('/')
}

async function readBytes(config: ResolvedConfig, target: string): Promise<Uint8Array> {
  const info = await stat(target)
  if (!info.isFile()) throw new ToolInputError(`not a file: ${displayPath(config.cwd, target)}`)
  if (info.size > config.maxReadBytes) throw new ToolInputError(`file exceeds ${config.maxReadBytes} bytes`)
  return new Uint8Array(await readFile(target))
}

/** 先写临时文件再改名：失败时原文件保持不变，读者也不会看到写了一半的文件。 */
async function writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function outline(kind: OfficeKind, bytes: Uint8Array): Promise<unknown> {
  switch (kind) {
    case 'xlsx': return inspectWorkbook(bytes)
    case 'docx': return inspectDocument(bytes)
    case 'pptx': return inspectPresentation(bytes)
  }
}

function inspectTool(config: ResolvedConfig): ToolDefinition {
  return {
    schema: {
      name: 'office_inspect',
      description: 'Outline an Office file in the workspace. xlsx: sheets with used range, header row and formula count. docx: headings, paragraph/table/word counts. pptx: slide count, size and titles. Call this before reading or editing a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '.xlsx, .docx or .pptx path relative to the workspace' } },
        required: ['path'],
      },
    },
    timeoutMs: TIMEOUT_MS,
    async execute(input) {
      const args = record(input)
      const target = await resolveInside(config.cwd, stringField(args.path, 'path'))
      const kind = kindOf(target)
      return { path: displayPath(config.cwd, target), kind, outline: await outline(kind, await readBytes(config, target)) }
    },
  }
}

function readTool(config: ResolvedConfig): ToolDefinition {
  return {
    schema: {
      name: 'office_read',
      description: 'Read content from an Office file in the workspace. xlsx: cell values of a sheet range; formula cells come back as { formula, value } with the computed value. docx: paragraphs and tables as numbered blocks. pptx: slide shapes, tables and speaker notes. Large content is paged; `truncated` tells you when to read further.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '.xlsx, .docx or .pptx path relative to the workspace' },
          sheet: { type: 'string', description: 'xlsx: sheet name, defaults to the first sheet' },
          range: { type: 'string', description: 'xlsx: A1 range such as "A1:D20", defaults to the used range' },
          offset: { type: 'number', description: 'docx: first block index (0-based)' },
          start: { type: 'number', description: 'pptx: first slide number (1-based)' },
          limit: { type: 'number', description: 'docx: max blocks; pptx: max slides; xlsx: max cells' },
        },
        required: ['path'],
      },
    },
    timeoutMs: TIMEOUT_MS,
    async execute(input) {
      const args = record(input)
      const target = await resolveInside(config.cwd, stringField(args.path, 'path'))
      const kind = kindOf(target)
      const bytes = await readBytes(config, target)
      const limit = optionalNumber(args.limit, 'limit')
      switch (kind) {
        case 'xlsx': {
          const sheet = optionalString(args.sheet, 'sheet')
          const range = optionalString(args.range, 'range')
          return readRange(bytes, {
            ...(sheet !== undefined ? { sheet } : {}),
            ...(range !== undefined ? { range } : {}),
            ...(limit !== undefined ? { maxCells: limit } : {}),
          })
        }
        case 'docx': {
          const offset = optionalNumber(args.offset, 'offset')
          return readDocument(bytes, { ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) })
        }
        case 'pptx': {
          const start = optionalNumber(args.start, 'start')
          return readPresentation(bytes, { ...(start !== undefined ? { start } : {}), ...(limit !== undefined ? { count: limit } : {}) })
        }
      }
    },
  }
}

const CREATE_SPEC_DESCRIPTION = [
  'Structured content; its shape depends on the file extension. Colors are 6-digit hex like "1F4E79".',
  'All formats accept theme?: { font?, headingFont?, accent? } (accent colors headings, table headers and charts).',
  'xlsx: { theme?, sheets: [{ name, rows?: Cell[][] (written from A1), columnWidths?: number[], rowHeights?: number[], freeze?: { rows?, columns? },',
  'styles?: [{ range: "A1:D1", style: Style }], merges?: ["A1:D1"], autoFilter?: "A1:D1", charts?: SheetChart[] }] }.',
  'Cell = string | number | boolean | null | { formula: "SUM(B2:B9)" }.',
  'Style = { bold?, italic?, underline?, font?, size?, color?, fill?, numFmt? (e.g. "#,##0.00", "0%"), align?: left|center|right, valign?: top|middle|bottom, wrap?, border?: thin|medium|thick|none, borderColor? }.',
  'SheetChart = { type: column|bar|line|area|pie|doughnut, title?, categories: "A2:A9", series: [{ values: "B2:B9", name? (default: header cell above), color? }],',
  'at: "F2" (top-left cell), width?: columns (8), height?: rows (16), stacked?, legend?, dataLabels? } - a native Excel chart linked to the cells; ranges may name another sheet like "\'Data\'!B2:B9".',
  'docx: { title?, theme?, page?: { size?: A4|Letter, orientation?: portrait|landscape, margin?: cm }, header?, footer?, pageNumbers?, blocks: Block[] }.',
  'Block = { type: "heading", level: 1-6, text } | { type: "paragraph", text: Inline, align?: left|center|right|justify } | { type: "list", items: Inline[], ordered? }',
  '| { type: "table", rows: string[][], header? } | { type: "pageBreak" } | { type: "chart", chart: Chart, width?: px, height?: px }. Inline = string | [{ text, bold?, italic?, underline? }].',
  'Chart = { type: column|bar|line|area|pie|doughnut, title?, categories: string[], series: [{ name, values: (number|null)[], color? }], stacked?, legend?, dataLabels? } - native and editable in Word/PowerPoint; pie takes one series.',
  'pptx: { title?, layout?: "16x9"|"4x3", theme?, background?, slideNumbers?, slides: [{ title?, subtitle? (title + subtitle only = cover slide), text?, bullets?: string[],',
  'table?: { rows: string[][], header? }, chart?: Chart, notes? }] }. Body parts on one slide stack top to bottom.',
].join(' ')

function createTool(config: ResolvedConfig): ToolDefinition {
  return {
    schema: {
      name: 'office_create',
      description: 'Create an .xlsx workbook, .docx document or .pptx deck in the workspace from a structured spec. Refuses to replace an existing file unless overwrite is true. Returns the path, size and an outline of the new file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'target path relative to the workspace; the extension selects the format' },
          spec: { type: 'object', description: CREATE_SPEC_DESCRIPTION },
          overwrite: { type: 'boolean', description: 'replace an existing file (default false)' },
        },
        required: ['path', 'spec'],
      },
    },
    timeoutMs: TIMEOUT_MS,
    async execute(input) {
      const args = record(input)
      const target = await resolveInside(config.cwd, stringField(args.path, 'path'))
      const kind = kindOf(target)
      if (!optionalBoolean(args.overwrite, 'overwrite')) {
        const exists = await stat(target).then(() => true, () => false)
        if (exists) throw new ToolInputError(`${displayPath(config.cwd, target)} already exists; pass overwrite: true or use office_edit`)
      }
      const bytes = kind === 'xlsx'
        ? await createWorkbook(workbookSpec(args.spec))
        : kind === 'docx'
          ? await createDocument(documentSpec(args.spec))
          : await createPresentation(presentationSpec(args.spec))
      await writeAtomic(target, bytes)
      return { path: displayPath(config.cwd, target), kind, bytes: bytes.byteLength, outline: await outline(kind, bytes) }
    },
  }
}

function editTool(config: ResolvedConfig): ToolDefinition {
  return {
    schema: {
      name: 'office_edit',
      description: [
        'Apply a batch of edits to an existing .xlsx workbook in the workspace. Edits run in order; if any fails, the file is left unchanged.',
        'Formulas are recomputed on save, so office_read afterwards shows the new values.',
        'Ops: { op: "setCells", sheet, start: "A1", rows: Cell[][] } | { op: "clear", sheet, range } | { op: "style", sheet, range, style: Style }',
        '| { op: "setColumnWidths", sheet, start?: "A", widths: number[] } | { op: "setRowHeights", sheet, start?: 1, heights: number[] } | { op: "merge" | "unmerge", sheet, range }',
        '| { op: "autoFilter", sheet, range: "A1:D1" | null } | { op: "addChart", sheet, chart: SheetChart } | { op: "removeChart", sheet, index }',
        '| { op: "addSheet", name } | { op: "renameSheet", sheet, name } | { op: "deleteSheet", sheet }.',
        'Cell, Style and SheetChart are as in office_create; office_inspect lists existing charts with their index. Charts are kept through edits and renames.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '.xlsx path relative to the workspace' },
          ops: { type: 'array', items: { type: 'object' }, description: 'edits to apply in order' },
          output: { type: 'string', description: 'write the result to this path instead of replacing the input' },
        },
        required: ['path', 'ops'],
      },
    },
    timeoutMs: TIMEOUT_MS,
    async execute(input) {
      const args = record(input)
      const source = await resolveInside(config.cwd, stringField(args.path, 'path'))
      if (kindOf(source) !== 'xlsx') throw new ToolInputError('office_edit supports .xlsx only; recreate .docx/.pptx with office_create')
      const outputPath = optionalString(args.output, 'output')
      const target = outputPath === undefined ? source : await resolveInside(config.cwd, outputPath)
      if (kindOf(target) !== 'xlsx') throw new ToolInputError('output must be an .xlsx path')
      // 先校验 ops，再碰文件：输入错误不应被文件错误掩盖。
      const ops = workbookOps(args.ops)
      const bytes = await editWorkbook(await readBytes(config, source), ops)
      await writeAtomic(target, bytes)
      return { path: displayPath(config.cwd, target), kind: 'xlsx', bytes: bytes.byteLength, outline: await inspectWorkbook(bytes) }
    },
  }
}

export const name = 'tool-office'

export function apply(ctx: Context, config: ToolOfficeConfig = {}): void {
  const resolved: ResolvedConfig = {
    cwd: config.cwd ?? process.cwd(),
    maxReadBytes: config.maxReadBytes ?? DEFAULT_MAX_OFFICE_BYTES,
    disabled: new Set(config.disabled ?? []),
  }
  const registry = ctx.get('tools') as ToolsService
  const tools = [inspectTool(resolved), readTool(resolved), createTool(resolved), editTool(resolved)]
  for (const tool of tools) {
    if (!resolved.disabled.has(tool.schema.name)) registry.register(tool)
  }
}

/**
 * 模型可见的 Office 工具：`office_inspect` / `office_read` 只读，`office_create` /
 * `office_edit` 写工作区。读写都经 `resolveInside` 限制在工作区内；写入的权限判定
 * 由 composition 层的守卫负责，与 `write_file` 同级。
 *
 * 挂载：`await ctx.plugin(toolOffice, { cwd })`。
 */
export const toolOffice = {
  name: 'tool-office',
  inject: ['tools'],
  apply,
}

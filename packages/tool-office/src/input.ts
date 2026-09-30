import type {
  CellInput,
  CellStyle,
  DocBlock,
  DocumentSpec,
  Inline,
  PresentationSpec,
  RangeStyle,
  SheetSpec,
  SlideSpec,
  TextSpan,
  WorkbookOp,
  WorkbookSpec,
} from '@tnega/office'
import { ToolInputError } from '@tnega/tools'

/**
 * 模型给出的结构化描述是 `unknown`：这里逐字段校验并构造出 `@tnega/office` 的类型，
 * 错误信息带上字段路径，让模型能自行修正。
 */

export function record(value: unknown, label = 'input'): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value))
  throw new ToolInputError(`${label} must be an object`)
}

export function stringField(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  throw new ToolInputError(`${label} must be a string`)
}

export function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringField(value, label)
}

export function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new ToolInputError(`${label} must be a finite number`)
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  throw new ToolInputError(`${label} must be a boolean`)
}

function array(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value
  throw new ToolInputError(`${label} must be an array`)
}

function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  const found = options.find(option => option === value)
  if (found === undefined) throw new ToolInputError(`${label} must be one of: ${options.join(', ')}`)
  return found
}

/** 可选字段：缺省时不出现该键（`exactOptionalPropertyTypes` 下不能写 `undefined`）。 */
function optional<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  const result: { [P in K]?: T } = {}
  if (value !== undefined) result[key] = value
  return result
}

// xlsx

function cell(value: unknown, label: string): CellInput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { formula: stringField(record(value, label).formula, `${label}.formula`) }
  }
  throw new ToolInputError(`${label} must be a string, number, boolean, null or { formula }`)
}

function rows(value: unknown, label: string): CellInput[][] {
  return array(value, label).map((row, r) => array(row, `${label}[${r}]`).map((each, c) => cell(each, `${label}[${r}][${c}]`)))
}

function cellStyle(value: unknown, label: string): CellStyle {
  const input = record(value, label)
  const align = input.align === undefined ? undefined : oneOf(input.align, ['left', 'center', 'right'], `${label}.align`)
  return {
    ...optional('bold', optionalBoolean(input.bold, `${label}.bold`)),
    ...optional('italic', optionalBoolean(input.italic, `${label}.italic`)),
    ...optional('numFmt', optionalString(input.numFmt, `${label}.numFmt`)),
    ...optional('fill', optionalString(input.fill, `${label}.fill`)),
    ...(align ? { align } : {}),
  }
}

function numbers(value: unknown, label: string): number[] {
  return array(value, label).map((each, index) => {
    const number = optionalNumber(each, `${label}[${index}]`)
    if (number === undefined) throw new ToolInputError(`${label}[${index}] must be a number`)
    return number
  })
}

function sheet(value: unknown, label: string): SheetSpec {
  const input = record(value, label)
  const freeze = input.freeze === undefined ? undefined : record(input.freeze, `${label}.freeze`)
  const styles: RangeStyle[] | undefined = input.styles === undefined
    ? undefined
    : array(input.styles, `${label}.styles`).map((each, index) => {
      const style = record(each, `${label}.styles[${index}]`)
      return { range: stringField(style.range, `${label}.styles[${index}].range`), style: cellStyle(style.style, `${label}.styles[${index}].style`) }
    })
  return {
    name: stringField(input.name, `${label}.name`),
    ...(input.rows !== undefined ? { rows: rows(input.rows, `${label}.rows`) } : {}),
    ...(input.columnWidths !== undefined ? { columnWidths: numbers(input.columnWidths, `${label}.columnWidths`) } : {}),
    ...(freeze ? {
      freeze: {
        ...optional('rows', optionalNumber(freeze.rows, `${label}.freeze.rows`)),
        ...optional('columns', optionalNumber(freeze.columns, `${label}.freeze.columns`)),
      },
    } : {}),
    ...(styles ? { styles } : {}),
  }
}

export function workbookSpec(value: unknown): WorkbookSpec {
  const input = record(value, 'spec')
  return { sheets: array(input.sheets, 'spec.sheets').map((each, index) => sheet(each, `spec.sheets[${index}]`)) }
}

const WORKBOOK_OPS = ['setCells', 'clear', 'style', 'setColumnWidths', 'addSheet', 'renameSheet', 'deleteSheet'] as const

function workbookOp(value: unknown, label: string): WorkbookOp {
  const input = record(value, label)
  const field = (key: string): string => stringField(input[key], `${label}.${key}`)
  switch (oneOf(input.op, WORKBOOK_OPS, `${label}.op`)) {
    case 'setCells': return { op: 'setCells', sheet: field('sheet'), start: field('start'), rows: rows(input.rows, `${label}.rows`) }
    case 'clear': return { op: 'clear', sheet: field('sheet'), range: field('range') }
    case 'style': return { op: 'style', sheet: field('sheet'), range: field('range'), style: cellStyle(input.style, `${label}.style`) }
    case 'setColumnWidths': return {
      op: 'setColumnWidths',
      sheet: field('sheet'),
      ...optional('start', optionalString(input.start, `${label}.start`)),
      widths: numbers(input.widths, `${label}.widths`),
    }
    case 'addSheet': return { op: 'addSheet', name: field('name') }
    case 'renameSheet': return { op: 'renameSheet', sheet: field('sheet'), name: field('name') }
    case 'deleteSheet': return { op: 'deleteSheet', sheet: field('sheet') }
  }
}

export function workbookOps(value: unknown): WorkbookOp[] {
  const ops = array(value, 'ops')
  if (ops.length === 0) throw new ToolInputError('ops must not be empty')
  return ops.map((each, index) => workbookOp(each, `ops[${index}]`))
}

// docx

function inline(value: unknown, label: string): Inline {
  if (typeof value === 'string') return value
  return array(value, label).map((each, index): TextSpan => {
    const span = record(each, `${label}[${index}]`)
    return {
      text: stringField(span.text, `${label}[${index}].text`),
      ...optional('bold', optionalBoolean(span.bold, `${label}[${index}].bold`)),
      ...optional('italic', optionalBoolean(span.italic, `${label}[${index}].italic`)),
      ...optional('underline', optionalBoolean(span.underline, `${label}[${index}].underline`)),
    }
  })
}

function textRows(value: unknown, label: string): string[][] {
  return array(value, label).map((row, r) => array(row, `${label}[${r}]`).map((each, c) => {
    if (typeof each === 'number' || typeof each === 'boolean') return String(each)
    return stringField(each, `${label}[${r}][${c}]`)
  }))
}

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

function docBlock(value: unknown, label: string): DocBlock {
  const input = record(value, label)
  switch (oneOf(input.type, ['heading', 'paragraph', 'list', 'table', 'pageBreak'], `${label}.type`)) {
    case 'heading': {
      const level = HEADING_LEVELS.find(each => each === input.level)
      if (level === undefined) throw new ToolInputError(`${label}.level must be an integer from 1 to 6`)
      return { type: 'heading', level, text: stringField(input.text, `${label}.text`) }
    }
    case 'paragraph': {
      const align = input.align === undefined ? undefined : oneOf(input.align, ['left', 'center', 'right', 'justify'], `${label}.align`)
      return { type: 'paragraph', text: inline(input.text, `${label}.text`), ...(align ? { align } : {}) }
    }
    case 'list': return {
      type: 'list',
      items: array(input.items, `${label}.items`).map((each, index) => inline(each, `${label}.items[${index}]`)),
      ...optional('ordered', optionalBoolean(input.ordered, `${label}.ordered`)),
    }
    case 'table': return {
      type: 'table',
      rows: textRows(input.rows, `${label}.rows`),
      ...optional('header', optionalBoolean(input.header, `${label}.header`)),
    }
    case 'pageBreak': return { type: 'pageBreak' }
  }
}

export function documentSpec(value: unknown): DocumentSpec {
  const input = record(value, 'spec')
  return {
    ...optional('title', optionalString(input.title, 'spec.title')),
    blocks: array(input.blocks, 'spec.blocks').map((each, index) => docBlock(each, `spec.blocks[${index}]`)),
  }
}

// pptx

function slide(value: unknown, label: string): SlideSpec {
  const input = record(value, label)
  const table = input.table === undefined ? undefined : record(input.table, `${label}.table`)
  return {
    ...optional('title', optionalString(input.title, `${label}.title`)),
    ...optional('subtitle', optionalString(input.subtitle, `${label}.subtitle`)),
    ...optional('text', optionalString(input.text, `${label}.text`)),
    ...(input.bullets !== undefined
      ? { bullets: array(input.bullets, `${label}.bullets`).map((each, index) => stringField(each, `${label}.bullets[${index}]`)) }
      : {}),
    ...(table ? {
      table: {
        rows: textRows(table.rows, `${label}.table.rows`),
        ...optional('header', optionalBoolean(table.header, `${label}.table.header`)),
      },
    } : {}),
    ...optional('notes', optionalString(input.notes, `${label}.notes`)),
  }
}

export function presentationSpec(value: unknown): PresentationSpec {
  const input = record(value, 'spec')
  const layout = input.layout === undefined ? undefined : oneOf(input.layout, ['16x9', '4x3'], 'spec.layout')
  return {
    ...optional('title', optionalString(input.title, 'spec.title')),
    ...(layout ? { layout } : {}),
    slides: array(input.slides, 'spec.slides').map((each, index) => slide(each, `spec.slides[${index}]`)),
  }
}

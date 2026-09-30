import * as formulajs from '@formulajs/formulajs'
import type ExcelJS from 'exceljs'
import { formatAddress, parseRange, type CellRange } from './address.js'
import { OfficeError } from './errors.js'

/**
 * 工作簿公式求值：自有的小型解析器负责引用、运算符与优先级，函数实现交给 formulajs。
 *
 * 这是为 Agent 校验与预览准备的**近似**求值，不追求与 Excel 完全一致：保存时仍设置
 * `fullCalcOnLoad`，由 Excel 打开时重算。不支持的语法（命名区域、整列引用、结构化引用、
 * 数组公式）求值为 `#NAME?` 或 `#VALUE!`，而不是抛错。
 */

export type Scalar = number | string | boolean | null

type Value = Scalar | FormulaError | Value[][]

/** Excel 错误值，例如 `#DIV/0!`；与 formulajs 返回的 `Error` 统一成本类型。 */
export class FormulaError {
  constructor(readonly code: string) {}
}

type Node =
  | { kind: 'literal', value: Scalar }
  | { kind: 'ref', sheet: string | undefined, range: CellRange }
  | { kind: 'call', name: string, args: Node[] }
  | { kind: 'unary', op: '-' | '+' | '%', arg: Node }
  | { kind: 'binary', op: string, left: Node, right: Node }

type Token =
  | { type: 'number', value: number }
  | { type: 'string', value: string }
  | { type: 'ref', sheet: string | undefined, range: string }
  | { type: 'name', value: string }
  | { type: 'op', value: string }
  | { type: 'paren', value: '(' | ')' }
  | { type: 'comma' }

class ParseError extends Error {}

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d+`
const REF = new RegExp(String.raw`^(?:('(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(${CELL}(?::${CELL})?)(?![\w(])`)
const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/
const NAME = /^[A-Za-z_][\w.]*/
const OPERATORS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%']

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let rest = source.trim().replace(/^=/, '')
  while (rest.length > 0) {
    const space = /^\s+/.exec(rest)
    if (space) { rest = rest.slice(space[0].length); continue }
    const ref = REF.exec(rest)
    if (ref) {
      const sheet = ref[1]?.startsWith("'") ? ref[1].slice(1, -1).replaceAll("''", "'") : ref[1]
      tokens.push({ type: 'ref', sheet, range: (ref[2] ?? '').replaceAll('$', '') })
      rest = rest.slice(ref[0].length)
      continue
    }
    const number = NUMBER.exec(rest)
    if (number) { tokens.push({ type: 'number', value: Number(number[0]) }); rest = rest.slice(number[0].length); continue }
    if (rest.startsWith('"')) {
      const match = /^"((?:[^"]|"")*)"/.exec(rest)
      if (!match) throw new ParseError('unterminated string')
      tokens.push({ type: 'string', value: (match[1] ?? '').replaceAll('""', '"') })
      rest = rest.slice(match[0].length)
      continue
    }
    const name = NAME.exec(rest)
    if (name) { tokens.push({ type: 'name', value: name[0] }); rest = rest.slice(name[0].length); continue }
    const char = rest[0]
    if (char === '(' || char === ')') { tokens.push({ type: 'paren', value: char }); rest = rest.slice(1); continue }
    if (char === ',') { tokens.push({ type: 'comma' }); rest = rest.slice(1); continue }
    const op = OPERATORS.find(each => rest.startsWith(each))
    if (!op) throw new ParseError(`unexpected character: ${char}`)
    tokens.push({ type: 'op', value: op })
    rest = rest.slice(op.length)
  }
  return tokens
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
}
const PREFIX_PRECEDENCE = 6

export function parseFormula(source: string): Node {
  const tokens = tokenize(source)
  let index = 0
  const peek = (): Token | undefined => tokens[index]
  const isParen = (token: Token | undefined, value: '(' | ')'): boolean => token?.type === 'paren' && token.value === value

  function primary(): Node {
    const token = tokens[index++]
    if (!token) throw new ParseError('unexpected end of formula')
    switch (token.type) {
      case 'number': return { kind: 'literal', value: token.value }
      case 'string': return { kind: 'literal', value: token.value }
      case 'ref': return { kind: 'ref', sheet: token.sheet, range: parseRange(token.range) }
      case 'op':
        if (token.value === '-' || token.value === '+') {
          return { kind: 'unary', op: token.value === '-' ? '-' : '+', arg: expression(PREFIX_PRECEDENCE) }
        }
        throw new ParseError(`unexpected operator: ${token.value}`)
      case 'paren': {
        if (token.value === ')') throw new ParseError('unexpected )')
        const inner = expression(0)
        expect(')')
        return inner
      }
      case 'name': {
        const next = peek()
        if (isParen(next, '(')) {
          index++
          const args: Node[] = []
          if (!isParen(peek(), ')')) {
            do { args.push(expression(0)) } while (peek()?.type === 'comma' && ++index)
          }
          expect(')')
          return { kind: 'call', name: token.value.toUpperCase(), args }
        }
        const upper = token.value.toUpperCase()
        if (upper === 'TRUE' || upper === 'FALSE') return { kind: 'literal', value: upper === 'TRUE' }
        throw new ParseError(`unsupported name: ${token.value}`)
      }
      case 'comma': throw new ParseError('unexpected ,')
    }
  }

  function expect(value: ')'): void {
    const token = tokens[index++]
    if (token?.type !== 'paren' || token.value !== value) throw new ParseError(`expected ${value}`)
  }

  function expression(minPrecedence: number): Node {
    let left = primary()
    for (;;) {
      const token = peek()
      if (token?.type !== 'op') return left
      if (token.value === '%') { index++; left = { kind: 'unary', op: '%', arg: left }; continue }
      const precedence = BINARY_PRECEDENCE[token.value]
      if (precedence === undefined || precedence <= minPrecedence) return left
      index++
      // `^` 在 Excel 中左结合，与其它二元运算一致。
      left = { kind: 'binary', op: token.value, left, right: expression(precedence) }
    }
  }

  const node = expression(0)
  if (index < tokens.length) throw new ParseError('unexpected trailing input')
  return node
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

function fromCell(value: ExcelJS.CellValue): Scalar | FormulaError {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof Date) return (value.getTime() - EXCEL_EPOCH) / 86_400_000
  if ('error' in value) return new FormulaError(String(value.error))
  if ('richText' in value) return value.richText.map(part => part.text).join('')
  if ('text' in value && typeof value.text === 'string') return value.text
  return null
}

function isError(value: Value): value is FormulaError {
  return value instanceof FormulaError
}

function topLeft(value: Value): Scalar | FormulaError {
  if (Array.isArray(value)) return topLeft(value[0]?.[0] ?? null)
  return value
}

function toNumber(value: Value): number | FormulaError {
  const scalar = topLeft(value)
  if (isError(scalar)) return scalar
  if (scalar === null) return 0
  if (typeof scalar === 'number') return scalar
  if (typeof scalar === 'boolean') return scalar ? 1 : 0
  const parsed = Number(scalar.trim())
  return scalar.trim() !== '' && Number.isFinite(parsed) ? parsed : new FormulaError('#VALUE!')
}

function toText(value: Scalar): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

function compare(op: string, a: Scalar, b: Scalar): boolean {
  const rank = (v: Scalar): number => (typeof v === 'number' || v === null ? 0 : typeof v === 'string' ? 1 : 2)
  const left = a === null ? (typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0) : a
  const right = b === null ? (typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0) : b
  let order = rank(left) - rank(right)
  if (order === 0) {
    const x = typeof left === 'string' ? left.toLowerCase() : Number(left)
    const y = typeof right === 'string' ? right.toLowerCase() : Number(right)
    order = x < y ? -1 : x > y ? 1 : 0
  }
  switch (op) {
    case '=': return order === 0
    case '<>': return order !== 0
    case '<': return order < 0
    case '>': return order > 0
    case '<=': return order <= 0
    default: return order >= 0
  }
}

/** 把 formulajs 的返回值（可能是 Error、undefined、数组）归一。 */
function fromFunction(result: unknown): Value {
  if (result instanceof Error) return new FormulaError(result.message.startsWith('#') ? result.message : '#VALUE!')
  if (result === undefined || result === null) return null
  if (typeof result === 'number') return Number.isFinite(result) ? result : new FormulaError('#NUM!')
  if (typeof result === 'string' || typeof result === 'boolean') return result
  if (result instanceof Date) return (result.getTime() - EXCEL_EPOCH) / 86_400_000
  if (Array.isArray(result)) {
    return result.map(row => (Array.isArray(row) ? row.map(cell => topLeft(fromFunction(cell))) : [topLeft(fromFunction(row))]))
  }
  return new FormulaError('#VALUE!')
}

/** 传给 formulajs 的参数：错误值还原成它识别的 Error。 */
function toFunctionArg(value: Value): unknown {
  if (isError(value)) return new Error(value.code)
  if (Array.isArray(value)) return value.map(row => row.map(toFunctionArg))
  return value
}

const FUNCTIONS: ReadonlyMap<string, (...args: unknown[]) => unknown> = new Map(
  Object.entries(formulajs).flatMap(([name, fn]) => (typeof fn === 'function' ? [[name, fn]] : [])),
)

/**
 * 一个工作簿的求值器：按需求值并缓存每个公式格，检测循环引用。
 * 工作簿在求值器存活期间不应被修改；修改后新建一个。
 */
export class WorkbookEvaluator {
  private readonly cache = new Map<string, Scalar | FormulaError>()
  private readonly visiting = new Set<string>()

  constructor(private readonly workbook: ExcelJS.Workbook) {}

  /** 求一个单元格的值；非公式格直接返回其值。 */
  cell(sheetName: string, row: number, column: number): Scalar | FormulaError {
    const sheet = this.workbook.getWorksheet(sheetName)
    if (!sheet) return new FormulaError('#REF!')
    const cell = sheet.getCell(row, column)
    const formula = cell.formula
    if (!formula) return fromCell(cell.value)
    const key = `${sheet.name}!${formatAddress({ row, column })}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    if (this.visiting.has(key)) return new FormulaError('#CIRCULAR!')
    this.visiting.add(key)
    let result: Scalar | FormulaError
    try {
      result = topLeft(this.evaluate(parseFormula(formula), sheet.name))
    } catch (error) {
      if (!(error instanceof ParseError) && !(error instanceof OfficeError)) throw error
      result = new FormulaError('#NAME?')
    } finally {
      this.visiting.delete(key)
    }
    this.cache.set(key, result)
    return result
  }

  private evaluate(node: Node, sheet: string): Value {
    switch (node.kind) {
      case 'literal': return node.value
      case 'ref': {
        const target = node.sheet ?? sheet
        const { start, end } = node.range
        if (start.row === end.row && start.column === end.column) return this.cell(target, start.row, start.column)
        const rows: Value[][] = []
        for (let row = start.row; row <= end.row; row++) {
          const values: Value[] = []
          for (let column = start.column; column <= end.column; column++) values.push(this.cell(target, row, column))
          rows.push(values)
        }
        return rows
      }
      case 'unary': {
        const value = toNumber(this.evaluate(node.arg, sheet))
        if (isError(value)) return value
        return node.op === '-' ? -value : node.op === '%' ? value / 100 : value
      }
      case 'binary': {
        const left = this.evaluate(node.left, sheet)
        const right = this.evaluate(node.right, sheet)
        const a = topLeft(left)
        const b = topLeft(right)
        if (isError(a)) return a
        if (isError(b)) return b
        if (node.op === '&') return toText(a) + toText(b)
        if (BINARY_PRECEDENCE[node.op] === 1) return compare(node.op, a, b)
        const x = toNumber(a)
        const y = toNumber(b)
        if (isError(x)) return x
        if (isError(y)) return y
        switch (node.op) {
          case '+': return x + y
          case '-': return x - y
          case '*': return x * y
          case '/': return y === 0 ? new FormulaError('#DIV/0!') : x / y
          default: return fromFunction(x ** y)
        }
      }
      case 'call': {
        const fn = FUNCTIONS.get(node.name)
        if (!fn) return new FormulaError('#NAME?')
        return fromFunction(fn(...node.args.map(arg => toFunctionArg(this.evaluate(arg, sheet)))))
      }
    }
  }
}

/** 输出用的标量：错误值以错误码文本表示。 */
export function displayValue(value: Scalar | FormulaError): Scalar {
  return isError(value) ? value.code : value
}

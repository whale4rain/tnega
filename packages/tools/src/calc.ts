export class CalculatorError extends Error {
  override name = 'CalculatorError'
}

type Token =
  | { type: 'number'; value: number }
  | { type: 'identifier'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'left-paren' }
  | { type: 'right-paren' }
  | { type: 'comma' }

interface FunctionSpec {
  min: number
  max?: number
  apply(args: readonly number[]): number
}

const CONSTANTS: Record<string, number> = {
  e: Math.E,
  pi: Math.PI,
  tau: Math.PI * 2,
}

const FUNCTIONS: Record<string, FunctionSpec> = {
  abs: { min: 1, max: 1, apply: ([value]) => Math.abs(value!) },
  round: {
    min: 1,
    max: 2,
    apply: ([value, precision]) => precision === undefined
      ? Math.round(value!)
      : Number(value!.toFixed(precision)),
  },
  floor: { min: 1, max: 1, apply: ([value]) => Math.floor(value!) },
  ceil: { min: 1, max: 1, apply: ([value]) => Math.ceil(value!) },
  sqrt: { min: 1, max: 1, apply: ([value]) => Math.sqrt(value!) },
  pow: { min: 2, max: 2, apply: ([base, exponent]) => Math.pow(base!, exponent!) },
  min: { min: 1, apply: (args) => Math.min(...args) },
  max: { min: 1, apply: (args) => Math.max(...args) },
  log: { min: 1, max: 1, apply: ([value]) => Math.log10(value!) },
  ln: { min: 1, max: 1, apply: ([value]) => Math.log(value!) },
}

function fail(message: string): never {
  throw new CalculatorError(message)
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (/[0-9.]/.test(char)) {
      const start = index
      while (index < source.length && /[0-9.]/.test(source[index]!)) {
        index += 1
      }
      let text = source.slice(start, index)
      if (index < source.length && /[eE]/.test(source[index]!)) {
        const exponentStart = index
        index += 1
        if (index < source.length && /[+-]/.test(source[index]!)) {
          index += 1
        }
        const digitsStart = index
        while (index < source.length && /[0-9]/.test(source[index]!)) {
          index += 1
        }
        if (index === digitsStart) {
          index = exponentStart
        } else {
          text = source.slice(start, index)
        }
      }
      const value = Number(text)
      if (!Number.isFinite(value)) fail(`invalid number: ${text}`)
      tokens.push({ type: 'number', value })
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) {
        index += 1
      }
      tokens.push({ type: 'identifier', value: source.slice(start, index) })
      continue
    }
    if ('+-*/%^'.includes(char)) {
      tokens.push({ type: 'operator', value: char })
      index += 1
      continue
    }
    if (char === '(') {
      tokens.push({ type: 'left-paren' })
      index += 1
      continue
    }
    if (char === ')') {
      tokens.push({ type: 'right-paren' })
      index += 1
      continue
    }
    if (char === ',') {
      tokens.push({ type: 'comma' })
      index += 1
      continue
    }
    fail(`unexpected character: ${char}`)
  }
  return tokens
}

class Parser {
  private position = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (!this.tokens.length) fail('empty expression')
    const value = this.expression()
    if (!this.atEnd()) fail(`unexpected token: ${this.peek()!.type}`)
    return value
  }

  private expression(): number {
    let value = this.term()
    while (this.matchOperator('+', '-')) {
      const operator = this.operatorValue(this.previous())
      const right = this.term()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }

  private term(): number {
    let value = this.factor()
    while (this.matchOperator('*', '/', '%')) {
      const operator = this.operatorValue(this.previous())
      const right = this.factor()
      if (operator === '*') {
        value *= right
      } else if (operator === '/') {
        if (right === 0) fail('division by zero')
        value /= right
      } else {
        if (right === 0) fail('modulo by zero')
        value %= right
      }
    }
    return value
  }

  private factor(): number {
    return this.unary()
  }

  private unary(): number {
    if (this.matchOperator('+', '-')) {
      const operator = this.operatorValue(this.previous())
      const value = this.unary()
      return operator === '-' ? -value : value
    }
    return this.power()
  }

  private power(): number {
    const base = this.primary()
    if (this.matchOperator('^')) {
      return Math.pow(base, this.unary())
    }
    return base
  }

  private primary(): number {
    const token = this.advance()
    switch (token.type) {
      case 'number':
        return token.value
      case 'identifier':
        return this.callOrConstant(token.value)
      case 'left-paren': {
        const value = this.expression()
        if (!this.matchType('right-paren')) fail('missing closing parenthesis')
        return value
      }
      default:
        fail(`unexpected token: ${token.type}`)
    }
  }

  private callOrConstant(name: string): number {
    if (this.matchType('left-paren')) return this.call(name)
    const constant = CONSTANTS[name]
    if (constant === undefined) fail(`unknown identifier: ${name}`)
    return constant
  }

  private call(name: string): number {
    const args: number[] = []
    if (!this.matchType('right-paren')) {
      do {
        args.push(this.expression())
      } while (this.matchType('comma'))
      if (!this.matchType('right-paren')) {
        fail('missing closing parenthesis after arguments')
      }
    }
    const spec = FUNCTIONS[name]
    if (!spec) fail(`unknown function: ${name}`)
    if (args.length < spec.min || (spec.max !== undefined && args.length > spec.max)) {
      fail(`${name} expects ${spec.min}${spec.max === undefined ? ' or more' : ` to ${spec.max}`} arguments`)
    }
    return spec.apply(args)
  }

  private advance(): Token {
    if (this.atEnd()) fail('unexpected end of expression')
    const token = this.tokens[this.position]!
    this.position += 1
    return token
  }

  private peek(): Token | undefined {
    return this.tokens[this.position]
  }

  private previous(): Token {
    return this.tokens[this.position - 1]!
  }

  private operatorValue(token: Token): string {
    if (token.type !== 'operator') fail(`unexpected token: ${token.type}`)
    return token.value
  }

  private atEnd(): boolean {
    return this.position >= this.tokens.length
  }

  private matchOperator(...values: string[]): boolean {
    const token = this.peek()
    if (token?.type === 'operator' && values.includes(token.value)) {
      this.position += 1
      return true
    }
    return false
  }

  private matchType(type: Token['type']): boolean {
    if (this.peek()?.type === type) {
      this.position += 1
      return true
    }
    return false
  }
}

export function evaluateExpression(source: string): number {
  const value = new Parser(tokenize(source)).parse()
  if (!Number.isFinite(value)) fail(`result is not a finite number: ${value}`)
  return value
}

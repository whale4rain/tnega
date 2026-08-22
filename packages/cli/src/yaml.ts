type YamlValue = Record<string, unknown> | unknown[] | string | number | boolean | null

function parseScalar(raw: string): YamlValue {
  const value = raw.trim()
  if (!value) return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  const comment = value.indexOf(' #')
  return comment >= 0 ? value.slice(0, comment).trim() : value
}

function parseSequence(lines: string[], index: number): { value: unknown[]; index: number } {
  const items: unknown[] = []
  const indent = lines[index]!.match(/^ */)![0].length
  let cursor = index
  while (cursor < lines.length) {
    const line = lines[cursor]!
    const currentIndent = line.match(/^ */)![0].length
    const body = line.trim()
    if (!body) {
      cursor += 1
      continue
    }
    if (currentIndent < indent) break
    if (!body.startsWith('- ')) break
    const rest = body.slice(2)
    if (!rest.trim()) {
      const nested = parseBlock(lines, cursor + 1)
      items.push(nested.value)
      cursor = nested.index
      continue
    }
    if (rest.includes(': ')) {
      const nestedLines = [`${' '.repeat(currentIndent + 2)}${rest}`, ...lines.slice(cursor + 1)]
      const nested = parseMapping(nestedLines)
      items.push(nested)
      cursor += 1
      while (cursor < lines.length) {
        const current = lines[cursor]!
        if (current.trim() && current.match(/^ */)![0].length > indent) {
          cursor += 1
        } else {
          break
        }
      }
    } else if (rest.trim().startsWith('- ')) {
      const nested = parseSequence(lines, cursor)
      items.push(nested.value)
      cursor = nested.index
    } else {
      items.push(parseScalar(rest))
      cursor += 1
    }
  }
  return { value: items, index: cursor }
}

function parseBlock(
  lines: string[],
  start: number,
): { value: Record<string, unknown> | unknown[]; index: number } {
  const line = lines[start]
  if (!line) return { value: [], index: start }
  if (line.trim().startsWith('- ')) return parseSequence(lines, start)
  return { value: parseMapping(lines, start), index: start }
}

function parseMapping(lines: string[], startIndex = 0): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const baseIndent = lines[startIndex]!.match(/^ */)![0].length
  let cursor = startIndex
  while (cursor < lines.length) {
    const line = lines[cursor]!
    const trimmed = line.trim()
    if (!trimmed) {
      cursor += 1
      continue
    }
    const indent = line.match(/^ */)![0].length
    if (indent < baseIndent) break
    const separator = trimmed.indexOf(':')
    if (separator < 0) {
      cursor += 1
      continue
    }
    const key = trimmed.slice(0, separator).trim()
    const rawValue = trimmed.slice(separator + 1).trim()
    if (rawValue) {
      result[key] = parseScalar(rawValue)
      cursor += 1
      continue
    }

    const next = lines[cursor + 1]
    if (!next || next.trim() === '' || next.match(/^ */)![0].length <= indent) {
      result[key] = null
      cursor += 1
      continue
    }
    if (next.trim().startsWith('- ')) {
      const nested = parseSequence(lines, cursor + 1)
      result[key] = nested.value
      cursor = nested.index
    } else {
      const nested = parseMapping(lines, cursor + 1)
      result[key] = nested
      cursor += 1
      while (cursor < lines.length) {
        const current = lines[cursor]!
        if (current.trim() && current.match(/^ */)![0].length > baseIndent) {
          cursor += 1
        } else {
          break
        }
      }
    }
  }
  return result
}

export function parseYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/)
  const clean = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('#')
  })
  if (!clean.length) return {}
  return parseMapping(clean)
}

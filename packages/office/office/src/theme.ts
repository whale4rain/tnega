import { OfficeError } from './errors.js'

/**
 * 文档的整体外观，三种格式共用：字体用于正文与标题，强调色用于标题、表头与图表。
 * 每种格式按自己的方式落实，缺省时保持各库的默认外观。
 */
export interface Theme {
  /** 字体名，例如 `Calibri`、`Arial`、`Microsoft YaHei`。 */
  font?: string
  /** 标题字体，缺省同 `font`。 */
  headingFont?: string
  /** 强调色，6 位十六进制 RGB，例如 `1F4E79`。 */
  accent?: string
}

export function assertColor(value: string | undefined, label: string): void {
  if (value !== undefined && !/^[0-9A-Fa-f]{6}$/.test(value)) {
    throw new OfficeError(`${label} must be a 6-digit hex color: ${value}`, 'OFFICE_INVALID')
  }
}

export function assertTheme(theme: Theme | undefined): void {
  assertColor(theme?.accent, 'theme.accent')
}

/** 把颜色向白色混合，用作表头等浅色底；`amount` 为白色所占比例。 */
export function tint(color: string, amount = 0.8): string {
  return [0, 2, 4]
    .map(index => parseInt(color.slice(index, index + 2), 16))
    .map(channel => Math.round(channel + (255 - channel) * amount).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

const BASE_PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9E480E']

/** 图表系列的默认配色：强调色打头，其后是区分度高的固定色。 */
export function palette(theme: Theme | undefined): string[] {
  const accent = theme?.accent?.toUpperCase()
  return accent ? [accent, ...BASE_PALETTE.filter(color => color !== accent)] : BASE_PALETTE
}

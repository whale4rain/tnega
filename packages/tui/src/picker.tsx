/**
 * A filterable list, the terminal's menu: sessions, models, changed files.
 * Typing filters, arrows move, Enter picks, Esc closes.
 */
import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { truncate, stringWidth } from './width.js'

export interface PickerItem {
  key: string
  label: string
  /** Shown dim after the label: a time, an id, a count. */
  detail?: string
  /** Marks the current choice. */
  current?: boolean
}

export function Picker({
  title,
  items,
  onPick,
  onClose,
  width,
  rows,
  empty = 'Nothing here yet.',
  hint,
  onKey,
}: {
  title: string
  items: readonly PickerItem[]
  onPick: (item: PickerItem) => void
  onClose: () => void
  width: number
  /** Rows the list may take. */
  rows: number
  empty?: string
  hint?: string
  /** Extra single-key actions on the selected item (e.g. `d` to delete); return true when handled. */
  onKey?: (input: string, item: PickerItem | undefined) => boolean
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex(item => item.current)))
  const filtered = useMemo(() => {
    const needle = query.toLowerCase()
    return needle ? items.filter(item => `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(needle)) : items
  }, [items, query])
  const selected = Math.min(index, Math.max(0, filtered.length - 1))

  useInput((input, key) => {
    if (key.escape) return onClose()
    if (key.upArrow) return setIndex(Math.max(0, selected - 1))
    if (key.downArrow) return setIndex(Math.min(filtered.length - 1, selected + 1))
    if (key.pageUp) return setIndex(Math.max(0, selected - rows))
    if (key.pageDown) return setIndex(Math.min(filtered.length - 1, selected + rows))
    if (key.return) {
      const item = filtered[selected]
      if (item) onPick(item)
      return
    }
    if (key.backspace) return setQuery(query.slice(0, -1))
    if (key.ctrl && onKey?.(input, filtered[selected])) return
    if (key.ctrl || key.meta || key.tab) return
    if (input) {
      setQuery(query + input)
      setIndex(0)
    }
  })

  const visible = Math.max(1, rows)
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), filtered.length - visible))
  const shown = filtered.slice(start, start + visible)
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text>
        <Text bold>{title}</Text>
        {query ? <Text dimColor>  filter: {query}</Text> : <Text dimColor>  type to filter</Text>}
      </Text>
      {filtered.length === 0 && <Text dimColor>{query ? 'No matches.' : empty}</Text>}
      {shown.map((item, offset) => {
        const active = start + offset === selected
        const detail = item.detail ? `  ${item.detail}` : ''
        const room = width - 4 - stringWidth(detail)
        return (
          <Text key={item.key} inverse={active}>
            {active ? '›' : ' '} {item.current ? '• ' : '  '}{truncate(item.label, Math.max(8, room - 2))}<Text dimColor={!active}>{detail}</Text>
          </Text>
        )
      })}
      <Text dimColor>{filtered.length > visible ? `${selected + 1}/${filtered.length} · ` : ''}↑↓ move · enter choose · esc close{hint ? ` · ${hint}` : ''}</Text>
    </Box>
  )
}

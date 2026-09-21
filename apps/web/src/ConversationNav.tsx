import { useEffect, useRef } from 'react'
import { Tooltip } from '@radix-ui/themes'

interface ConversationNavProps {
  turns: { id: string; content: string }[]
  index: number
  onSelect: (index: number) => void
}

export function ConversationNav({
  turns,
  index,
  onSelect,
}: ConversationNavProps) {
  const markers = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    const marker = markers.current[index]
    const ruler = marker?.parentElement
    if (marker && ruler) {
      ruler.scrollTop = marker.offsetTop - ruler.clientHeight / 2 + marker.clientHeight / 2
    }
  }, [index])
  if (turns.length < 2) return null
  return (
    <nav
      className="conversation-nav"
      aria-label="Conversation navigation"
    >
      {turns.map((turn, position) => {
        const preview = turn.content.trim().replace(/\s+/g, ' ').slice(0, 240) || 'Empty message'
        return (
          <Tooltip key={turn.id} className="turn-tooltip" side="right" delayDuration={150} content={
            <span className="turn-preview"><strong>Turn {position + 1}</strong><span>{preview}</span></span>
          }>
            <button
              type="button"
              className="turn-marker"
              ref={(node) => { markers.current[position] = node }}
              aria-label={`Turn ${position + 1}: ${preview}`}
              aria-current={position === index ? 'step' : undefined}
              onClick={() => onSelect(position)}
              onKeyDown={(event) => {
                const target = event.key === 'ArrowUp' ? position - 1
                  : event.key === 'ArrowDown' ? position + 1
                  : event.key === 'Home' ? 0
                  : event.key === 'End' ? turns.length - 1 : undefined
                if (target === undefined) return
                event.preventDefault()
                const next = Math.max(0, Math.min(turns.length - 1, target))
                markers.current[next]?.focus()
                onSelect(next)
              }}
            ><span aria-hidden="true" /></button>
          </Tooltip>
        )
      })}
    </nav>
  )
}

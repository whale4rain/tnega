import { SmilePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDismiss } from '../../lib/hooks'
import { projectApi } from '../../lib/project-api'
import { reactionsOf, type ProjectState } from '../../lib/project-model'
import { REACTIONS, type ReactionEmoji } from '../../lib/project-types'

const EMOJI = Object.keys(REACTIONS) as ReactionEmoji[]

/**
 * A message's emoji reactions: small chips under it (yours outlined), and a
 * button that appears on hover to add one. Clicking a chip adds or takes back
 * yours. Reactions only decorate a message; they wake no Agent.
 */
export function Reactions({ workspace, state, messageId, align = 'start' }: {
  workspace: string
  state: ProjectState
  messageId: string
  /** The side of the message they belong to: your bubbles sit on the right. */
  align?: 'start' | 'end'
}) {
  // Your clicks show at once; the server's echo replaces them.
  const [pending, setPending] = useState<Partial<Record<ReactionEmoji, boolean>>>({})
  const groups = reactionsOf(state, messageId)
  useEffect(() => {
    setPending(current => {
      const settled = Object.entries(current).filter(([emoji, on]) => groups.some(group => group.emoji === emoji && group.mine) === on)
      if (!settled.length) return current
      const next = { ...current }
      for (const [emoji] of settled) delete next[emoji as ReactionEmoji]
      return next
    })
  }, [groups])

  const shown = EMOJI.flatMap(emoji => {
    const group = groups.find(item => item.emoji === emoji)
    const wanted = pending[emoji]
    const mine = wanted ?? group?.mine ?? false
    const others = (group?.count ?? 0) - (group?.mine ? 1 : 0)
    const count = others + (mine ? 1 : 0)
    if (!count) return []
    const names = [...(mine ? ['You'] : []), ...(group?.names.filter(name => name !== 'You') ?? [])]
    return [{ emoji, mine, count, names, at: groups.findIndex(item => item.emoji === emoji) }]
  }).sort((a, b) => (a.at < 0 ? Infinity : a.at) - (b.at < 0 ? Infinity : b.at))

  const toggle = (emoji: ReactionEmoji, on: boolean) => {
    setPending(current => ({ ...current, [emoji]: on }))
    projectApi.react(workspace, state.project.id, messageId, emoji, on).catch(() => {
      setPending(current => {
        const next = { ...current }
        delete next[emoji]
        return next
      })
    })
  }

  return (
    <>
      {shown.length > 0 && (
        <div className={`reactions align-${align}`}>
          {shown.map(item => (
            <button
              key={item.emoji}
              type="button"
              className={`reaction-chip${item.mine ? ' mine' : ''}`}
              aria-pressed={item.mine}
              aria-label={`${item.emoji} ${item.count}: ${item.names.join(', ')}`}
              title={`${item.names.join(', ')} reacted ${item.emoji}`}
              onClick={() => toggle(item.emoji, !item.mine)}
            >
              <span className="reaction-emoji" aria-hidden>{item.emoji}</span>
              <span className="reaction-count" aria-hidden>{item.count}</span>
            </button>
          ))}
        </div>
      )}
      <ReactionPicker align={align} onPick={emoji => toggle(emoji, !(shown.find(item => item.emoji === emoji)?.mine ?? false))} />
    </>
  )
}

/** The hover button and its row of emoji. */
function ReactionPicker({ align, onPick }: { align: 'start' | 'end'; onPick: (emoji: ReactionEmoji) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useDismiss(open, root, () => setOpen(false))
  return (
    <div className={`reaction-picker align-${align}${open ? ' open' : ''}`} ref={root}>
      <button
        type="button"
        className="icon-button tiny"
        aria-label="Add reaction"
        title="Add reaction"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <SmilePlus size={14} />
      </button>
      {open && (
        <div className="reaction-menu" role="menu" aria-label="Reactions">
          {EMOJI.map(emoji => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              className="reaction-option"
              aria-label={`React ${emoji}`}
              onClick={() => {
                setOpen(false)
                onPick(emoji)
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

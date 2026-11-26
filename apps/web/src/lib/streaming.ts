import { useEffect, useRef, useState } from 'react'

/**
 * Streaming reply text (umbrella/conversation.md, Streaming). Two helpers keep a reply that is still
 * arriving calm to read: `settleMarkdown` hides Markdown that is only half written, and
 * `useSmoothText` reveals text at an even pace instead of in the bursts the network delivers.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * The text as it should render while more is still coming: an open code fence is closed, and the
 * last paragraph loses a dangling `**`, `*`, `_` or `` ` `` marker, a link whose target has not
 * arrived, and a table row whose header separator has not arrived. Finished text is never passed
 * through this, so nothing the model wrote is lost.
 */
export function settleMarkdown(text: string): string {
  const lines = text.split('\n')
  let fence: string | undefined
  let lastBlockStart = 0
  for (let i = 0; i < lines.length; i++) {
    const marker = FENCE.exec(lines[i] ?? '')?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined
        lastBlockStart = i + 1
      }
    } else if (marker) {
      fence = marker
      lastBlockStart = i
    } else if ((lines[i] ?? '').trim() === '') {
      lastBlockStart = i + 1
    }
  }
  // Inside a code fence the text is literal: only close the fence.
  if (fence) return `${text}\n${fence}`

  const head = lines.slice(0, lastBlockStart)
  let tail = lines.slice(lastBlockStart)
  // A table row with no `| --- |` line under it yet would show as raw pipes.
  if (tail.length > 0 && tail[0]?.trimStart().startsWith('|') && !tail.some(line => /^\s*\|?\s*:?-{3,}/.test(line))) {
    tail = []
  }
  let block = tail.join('\n')
  block = dropPartialLink(block)
  for (const marker of ['**', '__', '`', '*', '_']) block = dropDanglingMarker(block, marker)
  return [...head, ...(block ? [block] : [])].join('\n').replace(/\s+$/, '')
}

/** `[text](` or `[text` with no closing bracket yet: keep the words, drop the link syntax. */
function dropPartialLink(block: string): string {
  const open = block.lastIndexOf('[')
  if (open === -1) return block
  const rest = block.slice(open)
  if (/^\[[^\]]*\]\([^)]*\)/.test(rest)) return block
  const label = /^\[([^\]]*)\]?(\([^)]*)?$/.exec(rest)
  return label ? block.slice(0, open) + (label[1] ?? '') : block
}

/** An odd count of a marker means the last one has not been closed yet: drop that one. */
function dropDanglingMarker(block: string, marker: string): string {
  const pattern = marker === '*' || marker === '_'
    // A lone * or _ that is not part of ** / __, not a list bullet at the start of a line, and not inside a word.
    ? new RegExp(`(?<![\\${marker}\\w])\\${marker}(?![\\${marker}\\s])`, 'g')
    : new RegExp(marker.replace(/[*_`]/g, ch => `\\${ch}`), 'g')
  const matches = [...block.matchAll(pattern)]
  if (matches.length % 2 === 0) return block
  const last = matches.at(-1)
  if (!last || last.index === undefined) return block
  return block.slice(0, last.index) + block.slice(last.index + marker.length)
}

/**
 * How many characters to show next, given how many are waiting. The pace follows the backlog, so a
 * burst drains within about `catchUpMs`, and never drops below a reading pace of `floorPerMs`
 * (about 150 characters a second), so the last words of a burst do not crawl in.
 */
export function nextRevealLength(shown: number, target: number, elapsedMs: number, catchUpMs = 260, floorPerMs = 0.15): number {
  if (shown >= target) return target
  const backlog = target - shown
  const step = Math.max(1, Math.ceil(elapsedMs * floorPerMs), Math.ceil((backlog * elapsedMs) / catchUpMs))
  return Math.min(target, shown + step)
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The part of `text` to show now. While `active`, new text is revealed at an even pace on animation
 * frames; when the stream ends, or with reduced motion, the whole text shows at once. Text that is
 * replaced rather than extended (an edit, a new turn) also shows at once.
 */
export function useSmoothText(text: string, active: boolean): string {
  // What is already there when the reply mounts (its first words, or a reply you switch back to) shows
  // at once; only what arrives after that is revealed.
  const [shown, setShown] = useState(text.length)
  const shownRef = useRef(shown)
  const prefix = useRef(text)

  useEffect(() => {
    const extends_ = text.startsWith(prefix.current.slice(0, shownRef.current))
    prefix.current = text
    if (!active || !extends_ || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      shownRef.current = text.length
      setShown(text.length)
      return
    }
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const next = nextRevealLength(shownRef.current, text.length, now - last)
      last = now
      if (next !== shownRef.current) {
        shownRef.current = next
        setShown(next)
      }
      if (next < text.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, active])

  return active ? text.slice(0, Math.min(shown, text.length)) : text
}

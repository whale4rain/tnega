/**
 * Long tool results, made safe to render.
 *
 * Two separate problems live here. A tool's output can be megabytes — the card
 * has to bound what it puts in the DOM or one call freezes the conversation.
 * And an output the agent capped for the model carries a spill notice naming
 * where the rest of it went, which reads as noise unless the card lifts it out
 * and shows it as the pointer it is.
 *
 * The notice pattern mirrors `formatSpillNotice` in `@tnega/tool-spill`; that
 * package owns the format, and this is the read side of it. The web bundle
 * cannot import the workspace package, so the two are kept in step by
 * [`toolOutput.test.ts`](./toolOutput.test.ts), which pins the exact string.
 */

const SPILL_NOTICE_PATTERN =
  /\n\n\(Omitted (\d+) bytes\. Full formatted result stored at: (.+?)\. (.+)\)\s*$/

/** How much of a tool result the card renders before asking to be told to show the rest. */
export const MAX_RENDERED_CHARS = 4_000

export interface SpillNotice {
  /** Whatever the model saw before the notice; never includes the notice itself. */
  preview: string
  omittedBytes: number
  locator: string
  retrievalHint: string
}

/**
 * Read a spill notice off a tool result, if the whole thing ends with one.
 *
 * Returns `undefined` for anything else — including text that merely quotes the
 * wording — because a notice only counts when it closes the output it belongs to.
 */
export function readSpillNotice(text: string): SpillNotice | undefined {
  const match = text.match(SPILL_NOTICE_PATTERN)
  if (!match || match.index === undefined) return undefined
  const omittedBytes = Number(match[1])
  const locator = match[2]
  const retrievalHint = match[3]
  if (!Number.isFinite(omittedBytes) || !locator || !retrievalHint) return undefined
  return { preview: text.slice(0, match.index), omittedBytes, locator, retrievalHint }
}

export interface BoundedText {
  text: string
  /** True when `text` is a prefix of a longer string rather than the whole of it. */
  truncated: boolean
  totalChars: number
}

/** Keep at most `limit` characters, reporting whether anything was left out. */
export function boundedText(value: string, limit = MAX_RENDERED_CHARS): BoundedText {
  if (value.length <= limit) {
    return { text: value, truncated: false, totalChars: value.length }
  }
  return { text: value.slice(0, limit), truncated: true, totalChars: value.length }
}

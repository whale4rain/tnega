/**
 * Weather is Tnega's state language. The agent is a little cloud; what the
 * sky around it is doing tells you what the agent is doing, at a glance and
 * at any size. Each weather has exactly one meaning, so the same symbol can
 * appear on an avatar, a session row or a status line without a legend.
 *
 * | Weather  | Meaning                                              |
 * |----------|------------------------------------------------------|
 * | clear    | Idle and ready; the last run finished normally.       |
 * | cloudy   | Thinking: the model is producing a response.          |
 * | drizzle  | Working: one tool is running.                         |
 * | rain     | Busy: several tools or helpers are running at once.   |
 * | snow     | Frozen on you: an approval or a question is pending.  |
 * | sleet    | Retrying after a transient failure.                   |
 * | storm    | Something failed and needs a look.                    |
 * | fog      | Context is nearly full; details may be compacted.     |
 * | rainbow  | Just finished successfully (shown briefly).           |
 * | sprite   | Spawning helpers: new agents rising from this one.    |
 */
import type { Entry } from './timeline'

export type Weather =
  | 'clear'
  | 'cloudy'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'sleet'
  | 'storm'
  | 'fog'
  | 'rainbow'
  | 'sprite'

export const WEATHER_LABEL: Record<Weather, string> = {
  clear: 'Ready',
  cloudy: 'Thinking',
  drizzle: 'Running a tool',
  rain: 'Running several tools',
  snow: 'Waiting for you',
  sleet: 'Retrying',
  storm: 'Something failed',
  fog: 'Context nearly full',
  rainbow: 'Done',
  sprite: 'Starting helpers',
}

/** Weathers that only make sense while a run is active. */
export const ACTIVE_WEATHER: ReadonlySet<Weather> = new Set(['cloudy', 'drizzle', 'rain', 'sleet', 'sprite'])

export interface WeatherSignals {
  /** The run is streaming right now. */
  live: boolean
  /** An approval or a question is waiting on the user. */
  waiting?: boolean
  /** Share of the context window in use, 0–1. */
  contextRatio?: number
  /** The run settled within the last few seconds. */
  justFinished?: boolean
}

type AgentEntry = Extract<Entry, { kind: 'agent' }>

const RETRY_NOTICE = /\bretr(?:y|ying|ied)\b/iu

/** The weather of one agent turn, most urgent signal first. */
export function turnWeather(entry: AgentEntry, signals: WeatherSignals): Weather {
  if (signals.waiting) return 'snow'
  if (entry.status === 'error') return 'storm'
  const last = entry.blocks.at(-1)
  if (signals.live) {
    if (entry.blocks.some(block => block.kind === 'subagent' && block.agent.status === 'starting')) return 'sprite'
    if (last?.kind === 'notice' && last.tone !== 'info' && RETRY_NOTICE.test(last.text)) return 'sleet'
    const running = entry.blocks.filter(block => (block.kind === 'tool' && block.tool.status === 'running')
      || (block.kind === 'subagent' && block.agent.status === 'running')).length
    if (running >= 2) return 'rain'
    if (running === 1) return 'drizzle'
    return 'cloudy'
  }
  if ((signals.contextRatio ?? 0) >= 0.85) return 'fog'
  if (entry.status === 'done' && signals.justFinished) return 'rainbow'
  return 'clear'
}

/** A coarse forecast for a session row, from what the list knows about it. */
export function sessionWeather(state: { running?: boolean; waiting?: boolean; failed?: boolean }): Weather | undefined {
  if (state.waiting) return 'snow'
  if (state.running) return 'drizzle'
  if (state.failed) return 'storm'
  return undefined
}

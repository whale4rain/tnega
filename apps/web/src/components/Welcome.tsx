import {
  Bug,
  Code2,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Languages,
  Lightbulb,
  PenLine,
  Presentation,
  Table2,
  Telescope,
  type LucideIcon,
} from 'lucide-react'
import { useId, type CSSProperties } from 'react'
import { relativeTime } from '../lib/hooks'
import type { AgentType, SessionSummary } from '../lib/types'
import { BRAND_CLOUD, BRAND_CLOUD_CUTS_LARGE } from '../lib/avatar'
import { recentSessions, welcomeGreeting } from '../lib/welcome'
import { PenMark, type PenKind } from './PenMark'

interface Starter {
  icon: LucideIcon
  title: string
  prompt: string
}

const CODING_STARTERS: Starter[] = [
  { icon: Telescope, title: 'Map the codebase', prompt: 'Give me a tour of this codebase: the main modules, how they fit together, and where to start reading.' },
  { icon: Bug, title: 'Hunt a bug', prompt: 'Look for likely bugs or edge cases that are not handled in this project, and explain the most important ones.' },
  { icon: FlaskConical, title: 'Strengthen tests', prompt: 'Find the parts of this project with the weakest test coverage and propose focused tests for them.' },
  { icon: Code2, title: 'Review recent work', prompt: 'Review the most recent changes in this workspace and point out anything risky or unclear.' },
]

const WORK_STARTERS: Starter[] = [
  { icon: FileSpreadsheet, title: 'Summarize data', prompt: 'Find the CSV or Excel files in this workspace and build a summary workbook with totals by category, using formulas.' },
  { icon: FileText, title: 'Write a report', prompt: 'Read the documents in this workspace and write a concise report as a Word document.' },
  { icon: Presentation, title: 'Build a deck', prompt: 'Turn the main findings in this workspace into a short slide deck of five to seven slides.' },
  { icon: Table2, title: 'Tidy a table', prompt: 'Find messy tabular data in this workspace, clean it up, and save a tidy Excel workbook next to it.' },
]

const GENERAL_STARTERS: Starter[] = [
  { icon: Telescope, title: 'Explore this folder', prompt: 'Look around this workspace and summarize what is in it.' },
  { icon: PenLine, title: 'Draft a README', prompt: 'Draft a friendly README for this folder based on what it contains.' },
  { icon: Lightbulb, title: 'Brainstorm', prompt: 'Suggest five practical improvements to the contents of this workspace, most valuable first.' },
  { icon: Languages, title: 'Explain a concept', prompt: 'Explain how an AI agent uses tools, step by step, with a small concrete example.' },
]

const STARTERS: Record<AgentType, Starter[]> = { coding: CODING_STARTERS, work: WORK_STARTERS, general: GENERAL_STARTERS }

/** Stagger for the welcome's entrance: each piece arrives a beat after the one above it. */
function beat(index: number): CSSProperties {
  return { animationDelay: `${index * 70}ms` }
}

/**
 * The Tnega sliced brand cloud on a matte raised squircle tile: clean Swiss
 * geometry, gently floating. Still when reduced motion is asked for.
 */
export function WelcomeUmbrella() {
  const mask = `welcome-brand-${useId().replace(/:/g, '')}`
  return (
    <div className="welcome-umbrella" aria-hidden>
      <svg viewBox="0 0 64 64" focusable="false">
        <defs>
          <mask id={mask}>
            <path d={BRAND_CLOUD} fill="white" />
            {BRAND_CLOUD_CUTS_LARGE.ys.map(y => (
              <rect key={y} x="0" y={y} width="64" height={BRAND_CLOUD_CUTS_LARGE.height} fill="black" />
            ))}
          </mask>
        </defs>
        <rect className="welcome-umbrella-body" width="64" height="64" mask={`url(#${mask})`} />
      </svg>
    </div>
  )
}

/** The top of an empty session: the umbrella and one line of greeting. */
export function WelcomeHero({ agentType, now = new Date() }: { agentType: AgentType; now?: Date }) {
  const { hello, ask } = welcomeGreeting(now.getHours(), agentType)
  return (
    <div className="welcome-hero">
      <div className="welcome-beat" style={beat(0)}><WelcomeUmbrella /></div>
      <h2 className="welcome-greeting welcome-beat" style={beat(1)}>
        <span>{hello}</span> <span className="welcome-ask">{ask}</span>
      </h2>
    </div>
  )
}

/** Ready-made first messages, under the composer of an empty session: one quiet row of titles. */
export function WelcomeStarters({ agentType, onPick, disabled }: { agentType: AgentType; onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="welcome-starters" role="group" aria-label="Ways to start">
      {STARTERS[agentType].map((starter, index) => (
        <button
          key={starter.title}
          type="button"
          className="welcome-starter welcome-beat"
          style={beat(3 + index)}
          disabled={disabled}
          title={starter.prompt}
          aria-label={starter.title}
          onClick={() => onPick(starter.prompt)}
        >
          <starter.icon size={15} aria-hidden />
          {starter.title}
        </button>
      ))}
    </div>
  )
}

/** Whose turn a recent session is on, as a pen mark and the words beside it. */
function recentState(session: SessionSummary, when: string): { kind: PenKind; note: string } {
  if (session.waiting) return { kind: 'you', note: 'waiting on you' }
  if (session.running) return { kind: 'working', note: `working · ${when}` }
  return { kind: 'idle', note: when }
}

/**
 * The last few sessions in this folder, one row each with its pen mark: one waiting on you rises
 * to the top and says so; the rest say when. Nothing when there are none.
 */
export function WelcomeRecent({ sessions, onOpen, now = Date.now() }: { sessions: readonly SessionSummary[]; onOpen: (id: string) => void; now?: number }) {
  const recent = recentSessions(sessions)
  if (recent.length === 0) return null
  return (
    <section className="welcome-recent welcome-beat" style={beat(8)} aria-labelledby="welcome-recent-label">
      <h3 id="welcome-recent-label" className="welcome-recent-label">Pick up where you left off</h3>
      {recent.map(session => {
        const title = session.title || 'Untitled session'
        const when = relativeTime(session.updatedAt, now)
        const state = recentState(session, when)
        return (
          <button
            key={session.id}
            type="button"
            className={`welcome-recent-row${session.waiting ? ' needs-you' : ''}`}
            aria-label={`${title}, ${state.note}`}
            onClick={() => onOpen(session.id)}
          >
            <PenMark kind={state.kind} size={16} />
            <span className="welcome-recent-title">{title}</span>
            <span className="welcome-recent-time">{state.note}</span>
          </button>
        )
      })}
    </section>
  )
}

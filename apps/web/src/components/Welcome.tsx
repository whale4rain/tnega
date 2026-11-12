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
import { useEffect, useId, useRef, type CSSProperties } from 'react'
import type { AgentType } from '../lib/types'
import { eyeOffset, welcomeGreeting } from '../lib/welcome'

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
 * The brand cloud, alive: it floats, blinks now and then, and its eyes follow
 * the pointer. Same drawing as `--brand-cloud` / `--brand-eyes` in app.css (the
 * eyes are cut out of the cloud, so they show the page behind it in every palette);
 * change them together. Still when reduced motion is asked for.
 */
export function WelcomeCloud() {
  const svg = useRef<SVGSVGElement>(null)
  const mask = `welcome-cloud-${useId().replace(/:/g, '')}`

  useEffect(() => {
    const node = svg.current
    if (!node || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    let pointer: { x: number; y: number } | undefined
    const look = () => {
      frame = 0
      const box = node.getBoundingClientRect()
      const { x, y } = pointer ? eyeOffset(pointer.x - (box.left + box.width / 2), pointer.y - (box.top + box.height / 2)) : { x: 0, y: 0 }
      node.style.setProperty('--look-x', `${x.toFixed(2)}px`)
      node.style.setProperty('--look-y', `${y.toFixed(2)}px`)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(look) }
    const move = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; schedule() }
    const rest = () => { pointer = undefined; schedule() }
    window.addEventListener('pointermove', move, { passive: true })
    document.documentElement.addEventListener('pointerleave', rest)
    window.addEventListener('blur', rest)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      document.documentElement.removeEventListener('pointerleave', rest)
      window.removeEventListener('blur', rest)
    }
  }, [])

  return (
    <div className="welcome-cloud" aria-hidden>
      <svg ref={svg} viewBox="0 0 64 64" focusable="false">
        <mask id={mask}>
          <g fill="white">
            <circle cx="32" cy="23" r="16" />
            <circle cx="18" cy="34" r="14" />
            <circle cx="46" cy="34" r="14" />
            <circle cx="24" cy="46" r="13" />
            <circle cx="40" cy="46" r="13" />
          </g>
          <g className="welcome-cloud-look">
            <g className="welcome-cloud-eyes" fill="black">
              <rect x="20.8" y="23.5" width="8.4" height="17" rx="4.2" />
              <rect x="34.8" y="23.5" width="8.4" height="17" rx="4.2" />
            </g>
          </g>
        </mask>
        <rect className="welcome-cloud-body" width="64" height="64" mask={`url(#${mask})`} />
      </svg>
      <span className="welcome-cloud-shadow" />
    </div>
  )
}

/** The top of an empty session: the cloud and one line of greeting. */
export function WelcomeHero({ agentType, now = new Date() }: { agentType: AgentType; now?: Date }) {
  const { hello, ask } = welcomeGreeting(now.getHours(), agentType)
  return (
    <div className="welcome-hero">
      <div className="welcome-beat" style={beat(0)}><WelcomeCloud /></div>
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
          className="chip welcome-beat"
          style={beat(3 + index)}
          disabled={disabled}
          title={starter.prompt}
          aria-label={starter.title}
          onClick={() => onPick(starter.prompt)}
        >
          <starter.icon size={14} />
          {starter.title}
        </button>
      ))}
    </div>
  )
}

import { useState } from 'react'
import type { DisplayPlan } from './planDisplay'
import { planStatusText } from './planDisplay'

interface PlanPanelProps {
  plan?: DisplayPlan
}

export function PlanPanel({ plan }: PlanPanelProps) {
  const [open, setOpen] = useState(true)
  if (!plan) return null
  const status = planStatusText(plan)
  const done = plan.items.filter(item => item.status === 'done').length
  const failed = plan.items.filter(item => item.status === 'failed').length
  const running = plan.items.filter(item => item.status === 'pending').length
  return (
    <section className="plan-panel" aria-label="execution plan">
      <button
        type="button"
        className="plan-toggle"
        onClick={() => setOpen(open => !open)}
        aria-expanded={open}
      >
        <span className="marker">{open ? '[-]' : '[+]'}</span>
        <span className="plan-kind">plan</span>
        <span className="plan-count">{plan.items.length}</span>
        <span className="plan-progress">
          {done} done{failed ? ` / ${failed} err` : ''}{running ? ` / ${running} pending` : ''}
        </span>
        <span className={`plan-status ${plan.status}`}>{status}</span>
      </button>
      {open && (
        <div className="plan-body">
          {plan.summary && <div className="plan-summary">{plan.summary}</div>}
          <ol className="plan-items">
            {plan.items.map(item => (
              <li key={item.id} className={`plan-item ${item.status}`}>
                <span className="plan-item-marker">
                  {item.status === 'done' ? '[x]' : item.status === 'failed' ? '[!]' : '[ ]'}
                </span>
                <span className="plan-item-title">{item.title}</span>
                <span className="plan-item-status">{item.status}</span>
                {item.detail && <span className="plan-item-detail">{item.detail}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

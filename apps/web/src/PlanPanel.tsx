import { Check, Circle, CircleAlert, ListTodo } from 'lucide-react'
import type { DisplayPlan } from './planDisplay'
import { planStatusText } from './planDisplay'
import { Disclosure } from './conversation/Disclosure'

export function PlanPanel({ plan }: { plan?: DisplayPlan }) {
  if (!plan) return null
  const done = plan.items.filter((item) => item.status === 'done').length
  return (
    <section className="plan-panel" aria-label="Execution plan">
      <Disclosure
        defaultOpen
        title={
          <>
            <span>Plan</span>
            <span className="plan-progress">
              {done}/{plan.items.length}
            </span>
          </>
        }
        icon={<ListTodo size={14} aria-hidden="true" />}
        status={
          <span className={plan.status === 'failed' ? 'danger' : undefined}>
            {planStatusText(plan)}
          </span>
        }
      >
        <div className="plan-body">
          {plan.summary && <p className="plan-summary">{plan.summary}</p>}
          <ol className="plan-items">
            {plan.items.map((item) => {
              const Icon =
                item.status === 'done'
                  ? Check
                  : item.status === 'failed'
                    ? CircleAlert
                    : Circle
              return (
                <li key={item.id} className={`plan-item ${item.status}`}>
                  <Icon size={13} aria-label={item.status} />
                  <div>
                    <span>{item.title}</span>
                    {item.detail && (
                      <div className="plan-item-detail">{item.detail}</div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      </Disclosure>
    </section>
  )
}

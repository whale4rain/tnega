import type { LucideIcon } from 'lucide-react'

/**
 * Two to four mutually exclusive options as a row of radio buttons
 * (tnega-design §8): `.settings-choice-row` + `.settings-choice`.
 */
export function ChoiceField<T extends string>({ id, label, value, options, disabled, onChange, hint }: {
  id: string
  label: string
  value: T | undefined
  options: ReadonlyArray<readonly [T, string, LucideIcon?]>
  disabled?: boolean
  onChange: (value: T) => void
  hint?: string
}) {
  return (
    <div className="field span-2">
      <span className="field-label" id={`settings-${id}-label`}>{label}</span>
      <div className="settings-choice-row" role="radiogroup" aria-labelledby={`settings-${id}-label`}>
        {options.map(([option, text, Icon]) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={`settings-choice${value === option ? ' active' : ''}`}
            disabled={disabled}
            onClick={() => onChange(option)}
          >
            {Icon && <Icon size={14} aria-hidden />}{text}
          </button>
        ))}
      </div>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  )
}

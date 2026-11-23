import type { LucideIcon } from 'lucide-react'

/**
 * Two to four mutually exclusive options as a segmented control (controls.md): a sunken pill
 * track with a white thumb, `role="radio"` with `aria-checked`. Inside a Settings card the
 * card's title already names it, so `hideLabel` keeps the name for assistive tech only.
 */
export function ChoiceField<T extends string>({ id, label, value, options, disabled, onChange, hint, hideLabel }: {
  id: string
  label: string
  value: T | undefined
  options: ReadonlyArray<readonly [T, string, LucideIcon?]>
  disabled?: boolean
  onChange: (value: T) => void
  hint?: string
  hideLabel?: boolean
}) {
  return (
    <div className="field span-2">
      <span className={hideLabel ? 'visually-hidden' : 'field-label'} id={`settings-${id}-label`}>{label}</span>
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
      {hint && <span className="field-help">{hint}</span>}
    </div>
  )
}

import { useId, type ReactNode } from 'react'

/**
 * One decision in Settings (docs/design/umbrella/dialogs.md): a white card on the panel tone
 * with a title, one sentence, then the control. A single on/off decision puts its switch on the
 * title row (`control`); a card with one field names that field with its title (`labelFor`).
 */
export function SettingsCard({ title, description, control, labelFor, children, className }: {
  title: ReactNode
  description?: ReactNode
  /** Sits on the title row, on the right: a switch, or a small action. */
  control?: ReactNode
  /** The id of the one field this card's title names, so the title is that field's label. */
  labelFor?: string
  children?: ReactNode
  className?: string
}) {
  const titleId = useId()
  return (
    <section className={`settings-card${className ? ` ${className}` : ''}`} aria-labelledby={labelFor ? undefined : titleId}>
      <div className="settings-card-head">
        <div className="settings-card-text">
          {labelFor
            ? <label id={titleId} htmlFor={labelFor} className="settings-card-title">{title}</label>
            : <h4 id={titleId} className="settings-card-title">{title}</h4>}
          {description && <p className="settings-card-description">{description}</p>}
        </div>
        {control && <div className="settings-card-control">{control}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && <div className="settings-card-body">{children}</div>}
    </section>
  )
}

/** A setting that is plainly on or off: an ink switch (a native checkbox with role="switch"). */
export function Switch({ label, checked, onChange, disabled, id }: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
}) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="switch"
      aria-label={label}
      aria-checked={checked}
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
    />
  )
}

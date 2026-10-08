import { Check, ChevronDown } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useDismiss } from '../lib/hooks'

export interface MenuItem {
  key: string
  label: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** A trigger button with a floating list of actions. */
export function Menu({
  trigger,
  items,
  align = 'start',
  side = 'bottom',
  label,
  className,
}: {
  trigger: ReactNode
  items: Array<MenuItem | 'separator'>
  align?: 'start' | 'end'
  side?: 'top' | 'bottom'
  label: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useDismiss(open, root, () => setOpen(false))
  return (
    <div className="menu-root" ref={root}>
      <button
        type="button"
        className={className ?? 'icon-button'}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={event => {
          event.stopPropagation()
          setOpen(value => !value)
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className={`menu-popover align-${align} side-${side}`} role="menu">
          {items.map((item, index) => item === 'separator'
            ? <div key={`sep-${index}`} className="menu-separator" role="separator" />
            : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={`menu-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                onClick={event => {
                  event.stopPropagation()
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.icon && <span className="menu-item-icon">{item.icon}</span>}
                <span className="menu-item-label">{item.label}</span>
                {item.hint && <span className="menu-item-hint">{item.hint}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

export interface ChoiceOption<T extends string> {
  value: T
  label: string
  description?: string
  icon?: ReactNode
  tone?: 'danger'
}

/** A compact select rendered as a chip, used in the composer toolbar. */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  icon,
  disabled,
  side = 'top',
  align = 'start',
}: {
  value: T
  options: ReadonlyArray<ChoiceOption<T>>
  onChange: (value: T) => void
  label: string
  icon?: ReactNode
  disabled?: boolean
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useDismiss(open, root, () => setOpen(false))
  const current = options.find(option => option.value === value) ?? options[0]
  return (
    <div className="menu-root" ref={root}>
      <button
        type="button"
        className={`chip${current?.tone === 'danger' ? ' chip-danger' : ''}`}
        aria-label={`${label}: ${current?.label ?? ''}`}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
      >
        {current?.icon ?? icon}
        <span>{current?.label}</span>
        <ChevronDown size={13} className="chip-caret" />
      </button>
      {open && (
        <div className={`menu-popover align-${align} side-${side} menu-wide menu-scroll`} role="listbox" aria-label={label}>
          <div className="menu-heading">{label}</div>
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`menu-item menu-option${option.tone === 'danger' ? ' danger' : ''}`}
              onClick={() => {
                setOpen(false)
                if (option.value !== value) onChange(option.value)
              }}
            >
              {option.icon && <span className="menu-item-icon">{option.icon}</span>}
              <span className="menu-option-text">
                <span className="menu-item-label">{option.label}</span>
                {option.description && <span className="menu-option-desc">{option.description}</span>}
              </span>
              <span className="menu-check">{option.value === value && <Check size={14} />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export interface SectionItem {
  key: string
  label: string
  description?: string
  icon?: ReactNode
  tone?: 'danger'
  selected: boolean
  select: () => void
}

export interface ChoiceSection {
  key: string
  label: string
  items: SectionItem[]
}

/** Turns a typed option list into a section of a `SectionChoice`. */
export function choiceSection<T extends string>(
  key: string,
  label: string,
  options: ReadonlyArray<ChoiceOption<T>>,
  value: T,
  onChange: (value: T) => void,
): ChoiceSection {
  return {
    key,
    label,
    items: options.map(option => ({
      key: option.value,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.icon ? { icon: option.icon } : {}),
      ...(option.tone ? { tone: option.tone } : {}),
      selected: option.value === value,
      select: () => { if (option.value !== value) onChange(option.value) },
    })),
  }
}

/**
 * One chip for several related settings: the chip shows a short summary and
 * the popover lists each setting as its own section.
 */
export function SectionChoice({
  label,
  summary,
  icon,
  tone,
  sections,
  disabled,
  side = 'top',
  align = 'start',
  action,
}: {
  label: string
  summary: string
  icon?: ReactNode
  tone?: 'danger'
  sections: ChoiceSection[]
  disabled?: boolean
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  action?: { label: string; onSelect: () => void }
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useDismiss(open, root, () => setOpen(false))
  return (
    <div className="menu-root" ref={root}>
      <button
        type="button"
        className={`chip${tone === 'danger' ? ' chip-danger' : ''}`}
        aria-label={`${label}: ${summary}`}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
      >
        {icon}
        <span>{summary}</span>
        <ChevronDown size={13} className="chip-caret" />
      </button>
      {open && (
        <div className={`menu-popover align-${align} side-${side} menu-wide menu-scroll`} role="listbox" aria-label={label}>
          {sections.map((section, index) => (
            <div key={section.key} className="menu-section" role="group" aria-label={section.label}>
              {index > 0 && <div className="menu-separator" role="separator" />}
              <div className="menu-heading">{section.label}</div>
              {section.items.map(item => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={item.selected}
                  className={`menu-item menu-option${item.tone === 'danger' ? ' danger' : ''}`}
                  onClick={() => {
                    setOpen(false)
                    item.select()
                  }}
                >
                  {item.icon && <span className="menu-item-icon">{item.icon}</span>}
                  <span className="menu-option-text">
                    <span className="menu-item-label">{item.label}</span>
                    {item.description && <span className="menu-option-desc">{item.description}</span>}
                  </span>
                  <span className="menu-check">{item.selected && <Check size={14} />}</span>
                </button>
              ))}
            </div>
          ))}
          {action && <><div className="menu-separator" role="separator" /><button type="button" className="menu-item" onClick={() => { setOpen(false); action.onSelect() }}>{action.label}</button></>}
        </div>
      )}
    </div>
  )
}

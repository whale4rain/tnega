export type ThemePreference = 'system' | 'light' | 'dark'

interface ThemeToggleProps {
  value: ThemePreference
  onChange: (next: ThemePreference) => void
}

const LABELS: Record<ThemePreference, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
}

export function ThemeToggle({ value, onChange }: ThemeToggleProps) {
  const cycle: Record<ThemePreference, ThemePreference> = {
    system: 'light',
    light: 'dark',
    dark: 'system',
  }
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => onChange(cycle[value])}
      title="theme"
    >
      {LABELS[value]}
    </button>
  )
}

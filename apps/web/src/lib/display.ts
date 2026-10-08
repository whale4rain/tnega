import { useEffect } from 'react'
import { useStoredState } from './hooks'

/**
 * How information is displayed on this device: the colour palette (inside the
 * light/dark mode from `useTheme`), density, text size and reading width.
 * Each choice is a `data-*` attribute on the root element; tokens.css maps it
 * to tokens, so components need no changes. index.html applies the same
 * stored values before first paint.
 */
export const PALETTES = [
  { id: 'sky', label: 'Sky', description: 'Cool blue-grey with a clear-sky accent' },
  { id: 'sand', label: 'Sand', description: 'Warm paper and ink, terracotta accent' },
  { id: 'forest', label: 'Forest', description: 'Green-grey neutrals, deep teal accent' },
  { id: 'graphite', label: 'Graphite', description: 'Neutral greys with the strongest contrast' },
] as const

export type Palette = typeof PALETTES[number]['id']
export type Density = 'compact' | 'comfortable'
export type TextSize = 'small' | 'default' | 'large'
export type ReadingWidth = 'narrow' | 'standard' | 'wide' | 'full'

export interface DisplayPreferences {
  palette: Palette
  density: Density
  textSize: TextSize
  readingWidth: ReadingWidth
}

export const DISPLAY_OPTIONS = {
  palette: PALETTES.map(palette => palette.id),
  density: ['compact', 'comfortable'],
  textSize: ['small', 'default', 'large'],
  readingWidth: ['narrow', 'standard', 'wide', 'full'],
} as const satisfies { [K in keyof DisplayPreferences]: readonly DisplayPreferences[K][] }

export const DISPLAY_DEFAULTS: DisplayPreferences = { palette: 'sky', density: 'compact', textSize: 'default', readingWidth: 'standard' }

/** Storage key and root attribute of each preference; index.html mirrors these. */
export const DISPLAY_KEYS = {
  palette: { storage: 'tnega.palette', attribute: 'palette' },
  density: { storage: 'tnega.density', attribute: 'density' },
  textSize: { storage: 'tnega.textSize', attribute: 'textSize' },
  readingWidth: { storage: 'tnega.readingWidth', attribute: 'reading' },
} as const satisfies { [K in keyof DisplayPreferences]: { storage: string; attribute: string } }

export function applyDisplay(root: HTMLElement, preferences: DisplayPreferences): void {
  for (const key of Object.keys(DISPLAY_KEYS) as Array<keyof DisplayPreferences>) {
    root.dataset[DISPLAY_KEYS[key].attribute] = preferences[key]
  }
}

export type DisplayChange = <K extends keyof DisplayPreferences>(key: K, value: DisplayPreferences[K]) => void

export function useDisplay(): [DisplayPreferences, DisplayChange] {
  const [palette, setPalette] = useStoredState<Palette>(DISPLAY_KEYS.palette.storage, DISPLAY_DEFAULTS.palette, DISPLAY_OPTIONS.palette)
  const [density, setDensity] = useStoredState<Density>(DISPLAY_KEYS.density.storage, DISPLAY_DEFAULTS.density, DISPLAY_OPTIONS.density)
  const [textSize, setTextSize] = useStoredState<TextSize>(DISPLAY_KEYS.textSize.storage, DISPLAY_DEFAULTS.textSize, DISPLAY_OPTIONS.textSize)
  const [readingWidth, setReadingWidth] = useStoredState<ReadingWidth>(DISPLAY_KEYS.readingWidth.storage, DISPLAY_DEFAULTS.readingWidth, DISPLAY_OPTIONS.readingWidth)
  useEffect(() => {
    applyDisplay(document.documentElement, { palette, density, textSize, readingWidth })
  }, [palette, density, textSize, readingWidth])
  const change: DisplayChange = (key, value) => {
    const setters: { [K in keyof DisplayPreferences]: (value: DisplayPreferences[K]) => void } = {
      palette: setPalette, density: setDensity, textSize: setTextSize, readingWidth: setReadingWidth,
    }
    setters[key](value)
  }
  return [{ palette, density, textSize, readingWidth }, change]
}

/**
 * Dev-only calibration page for the weather language: every weather on the
 * main cloud and on a few helper shapes, at the sizes the app uses, in both
 * themes. Served by `vite` at /weather.html; not part of the production build.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentAvatar } from './components/AgentAvatar'
import { WEATHER_LABEL, type Weather } from './lib/weather'
import './styles/tokens.css'
import './styles/app.css'
import './styles/project.css'

const WEATHERS = Object.keys(WEATHER_LABEL) as Weather[]
const HELPERS = ['thread-a', 'thread-b', 'thread-c']

function Sky({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <section data-theme={theme} className="weather-sheet" style={{ background: 'var(--bg)', color: 'var(--text)', padding: 24 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <span className="brand-mark large" />
        <strong>{theme === 'light' ? 'Daylight' : 'Night sky'}</strong>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 18 }}>
        {WEATHERS.map(weather => (
          <figure key={weather} style={{ margin: 0, display: 'grid', justifyItems: 'center', gap: 6, padding: 12, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <AgentAvatar id="main" role="coordinator" size={72} weather={weather} live={weather === 'cloudy'} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <AgentAvatar id="main" role="coordinator" size={26} weather={weather} />
              {HELPERS.map(id => <AgentAvatar key={id} id={id} size={20} weather={weather} />)}
            </div>
            <figcaption style={{ fontSize: 12.5 }}><strong>{weather}</strong> · <span style={{ color: 'var(--text-3)' }}>{WEATHER_LABEL[weather]}</span></figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sky theme="light" />
    <Sky theme="dark" />
  </StrictMode>,
)

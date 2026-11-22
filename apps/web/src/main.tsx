import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AuthGate } from './components/AuthGate'
import { ConfirmHost } from './components/ConfirmHost'
// Faces are bundled so desktop, Web and every OS render the same type (tnega-design §6.1): Geist for Latin,
// Noto Sans SC for Chinese (its unicode-range files load only when CJK text appears), JetBrains Mono for code.
// Titles (--font-display) are Geist at 700 too (Umbrella, §6.1): no separate display face.
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/project.css'
import './styles/workbench.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
    <ConfirmHost />
  </StrictMode>,
)

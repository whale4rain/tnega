import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ConfirmHost } from './components/ConfirmHost'
// Faces are bundled so desktop, Web and every OS render the same type (tnega-design §6.1): Geist for Latin,
// Noto Sans SC for Chinese (its unicode-range files load only when CJK text appears), JetBrains Mono for code.
// Fraunces (optical sizes: high contrast at display sizes), a serif, only for greetings and page titles (--font-display).
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import '@fontsource-variable/fraunces/opsz.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/project.css'
import './styles/workbench.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ConfirmHost />
  </StrictMode>,
)

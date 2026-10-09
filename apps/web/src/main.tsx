import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ConfirmHost } from './components/ConfirmHost'
// The UI face is bundled so desktop, Web and every OS render the same rounded, readable type (tnega-design §6.1).
import '@fontsource-variable/nunito/wght.css'
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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ConfirmHost } from './components/ConfirmHost'
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

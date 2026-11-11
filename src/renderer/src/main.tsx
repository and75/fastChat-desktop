import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { resolveLocale, setLocale } from '@shared/i18n'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import './index.css'

// Prima del primo render: la lingua del sistema; poi App applica quella scelta nelle impostazioni.
setLocale(resolveLocale('auto', window.api.system.locale))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

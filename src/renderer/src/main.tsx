import React from 'react'
import { createRoot } from 'react-dom/client'

import { EventHorizon } from './EventHorizon'
import { electronApi } from './api'
import { initTheme } from './theme'

/**
 * The Electron entry point — one of several possible hosts. It supplies the
 * preload bridge as the API and renders the same component any other host would.
 * Styles come in via EventHorizon so an embedding host gets them too.
 */
// Before the first paint. Applied in an effect instead, a light setting shows
// one frame of the dark theme, which reads as a flash of black on launch.
initTheme()

const api = electronApi()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {api ? (
      <EventHorizon api={api} />
    ) : (
      <div style={{ padding: 40, fontFamily: 'system-ui', color: '#d16a63' }}>
        No host API found on the preload bridge — the preload script did not load.
      </div>
    )}
  </React.StrictMode>
)

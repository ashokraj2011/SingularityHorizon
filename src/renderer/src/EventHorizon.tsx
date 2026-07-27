import type { AcpStudioApi } from '@shared/ipc'

import { App } from './App'
import { peekApi, setApi } from './api'
import { setSlots, type EventHorizonSlots } from './slots'

import './styles/index.css'
import 'highlight.js/styles/github-dark.css'

export interface EventHorizonProps {
  /** Optional host-rendered chrome; see slots.ts. */
  slots?: EventHorizonSlots
  /**
   * The host's implementation of the client API. This is the only thing that
   * differs between an Electron window, a browser tab talking to a daemon, a
   * VS Code webview, and a test.
   */
  api: AcpStudioApi
}

/**
 * Embeddable root. Everything else in the UI is an implementation detail.
 *
 *   <EventHorizon api={myHostApi} />
 *
 * The API is registered during render rather than in an effect because the
 * store's `bootstrap()` fires from App's mount effect, which runs before any
 * parent effect would have had a chance to set it.
 */
export function EventHorizon({ api, slots }: EventHorizonProps): React.JSX.Element {
  if (peekApi() !== api) setApi(api)
  setSlots(slots)
  return <App />
}

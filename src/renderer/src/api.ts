import type { AcpStudioApi } from '@shared/ipc'

/**
 * The UI's single dependency on its host.
 *
 * Everything the interface needs — sessions, prompting, permissions, skills,
 * attachments, the event stream — arrives through one typed object. The UI
 * never imports Electron, Node, or any transport; swapping this out is the
 * whole job of embedding Event Horizon somewhere else.
 *
 * Implementations that exist or are plausible:
 *   - Electron   : `window.acp` from the preload bridge (what ships today)
 *   - Web        : a WebSocket/HTTP client against a host running the agent
 *   - VS Code    : `postMessage` to the extension host
 *   - Tests      : a plain object, no process at all
 *
 * Held in a module-level slot rather than React context because the store is a
 * zustand singleton and needs the same instance outside the component tree.
 * One Event Horizon per page, which is the realistic embedding shape.
 */
let current: AcpStudioApi | null = null

export function setApi(api: AcpStudioApi): void {
  current = api
}

export function getApi(): AcpStudioApi {
  if (!current) {
    throw new Error(
      'Event Horizon has no host API. Render <EventHorizon api={…} /> or call setApi() first.'
    )
  }
  return current
}

export function peekApi(): AcpStudioApi | null {
  return current
}

/**
 * Convenience for the Electron build: the preload bridge puts the API on
 * `window.acp`. Returns null anywhere else, so a host that forgets to pass one
 * gets the explicit error above instead of a confusing undefined-property crash.
 */
export function electronApi(): AcpStudioApi | null {
  return (globalThis as { acp?: AcpStudioApi }).acp ?? null
}

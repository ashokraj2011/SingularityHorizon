import type { ReactNode } from 'react'

import type { SessionSnapshot } from '@shared/ipc'

/**
 * Render slots a host can fill without forking the UI.
 *
 * The alternative — a host editing TopBar.tsx to show its own workspace and
 * phase — turns its copy into a fork, and the fork drifts. A slot receives the
 * session plus whatever opaque context the host pushed for that working
 * directory, and returns whatever it wants.
 *
 * Core never interprets `hostContext`; only the slot that the same host wrote
 * knows its shape. That asymmetry is the point: the host understands both
 * sides, core understands neither.
 */
export interface SlotContext {
  session: SessionSnapshot
  /** Whatever the host passed to setHostContext() for this session's cwd. */
  hostContext: unknown
}

export interface EventHorizonSlots {
  /** Top bar, immediately after the working-directory path. */
  topBarLeading?: (ctx: SlotContext) => ReactNode
  /** Top bar, just before the session menu. */
  topBarTrailing?: (ctx: SlotContext) => ReactNode
  /** Directly above the composer — good for phase or handoff banners. */
  composerAbove?: (ctx: SlotContext) => ReactNode
  /** Shown in the sidebar under the session list. */
  sidebarFooter?: () => ReactNode
}

let slots: EventHorizonSlots = {}

export function setSlots(next: EventHorizonSlots | undefined): void {
  slots = next ?? {}
}

export function getSlots(): EventHorizonSlots {
  return slots
}

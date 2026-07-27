/**
 * Public entry point for embedding Event Horizon in another application.
 *
 * The UI is transport-agnostic: it imports no Electron and no Node, and reaches
 * its host only through the `AcpStudioApi` object you pass to `<EventHorizon>`.
 * Provide that object however your host can — IPC, WebSocket, postMessage, or a
 * plain in-memory stub — and the interface works unchanged.
 */
export { EventHorizon, type EventHorizonProps } from './EventHorizon'
export { setApi, getApi, peekApi, electronApi } from './api'
export { setSlots, getSlots, type EventHorizonSlots, type SlotContext } from './slots'

/** Individual pieces, for hosts that want to compose their own layout. */
export { App } from './App'
export { Thread } from './components/Thread'
export { Composer } from './components/Composer'
export { TopBar } from './components/TopBar'
export { Sidebar } from './components/Sidebar'
export { ContextPanel } from './components/ContextPanel'
export { useStore, useActiveSession, useHostContext } from './store'

export type {
  AcpStudioApi,
  AgentDefinition,
  AttachmentRef,
  AttachmentSummary,
  MainEvent,
  PromptRequest,
  SessionSnapshot,
  SessionStatus,
  SkillInfo,
  ThreadBlock
} from '@shared/ipc'
export type { ContextInfo, UsageInfo } from '@shared/contextInfo'

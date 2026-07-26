import { create } from 'zustand'

import type { ContentBlock } from '@shared/acp'
import type { AgentDefinition, MainEvent, SessionSnapshot } from '@shared/ipc'

interface StoreState {
  sessions: Record<string, SessionSnapshot>
  order: string[]
  activeId: string | null
  agents: AgentDefinition[]
  launching: boolean
  launchError: string | null

  bootstrap: () => Promise<void>
  applyEvent: (event: MainEvent) => void
  newSession: (cwd: string, agentId: string) => Promise<void>
  closeSession: (id: string) => Promise<void>
  setActive: (id: string) => void
  send: (text: string) => Promise<void>
  cancel: () => void
  setConfigOption: (optionId: string, value: string) => Promise<void>
  answerPermission: (requestId: string, optionId: string | null) => Promise<void>
}

export const useStore = create<StoreState>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  agents: [],
  launching: false,
  launchError: null,

  bootstrap: async () => {
    const [agents, sessions] = await Promise.all([
      window.acp.listAgents(),
      window.acp.listSessions()
    ])
    set({
      agents,
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
      order: sessions.map((s) => s.id),
      activeId: sessions[0]?.id ?? null
    })
  },

  applyEvent: (event) => {
    const state = get()
    switch (event.type) {
      case 'session:created': {
        if (state.sessions[event.session.id]) return
        set({
          sessions: { ...state.sessions, [event.session.id]: event.session },
          order: [...state.order, event.session.id],
          activeId: event.session.id
        })
        return
      }
      case 'session:blocks': {
        const existing = state.sessions[event.sessionId]
        if (!existing) return
        set({
          sessions: {
            ...state.sessions,
            [event.sessionId]: { ...existing, blocks: event.blocks }
          }
        })
        return
      }
      case 'session:patch': {
        const existing = state.sessions[event.sessionId]
        if (!existing) return
        set({
          sessions: {
            ...state.sessions,
            [event.sessionId]: { ...existing, ...event.patch }
          }
        })
        return
      }
      case 'session:removed': {
        const { [event.sessionId]: _removed, ...rest } = state.sessions
        const order = state.order.filter((id) => id !== event.sessionId)
        set({
          sessions: rest,
          order,
          activeId: state.activeId === event.sessionId ? (order[0] ?? null) : state.activeId
        })
        return
      }
      default:
        return
    }
  },

  newSession: async (cwd, agentId) => {
    set({ launching: true, launchError: null })
    try {
      await window.acp.createSession({ cwd, agentId })
    } catch (err) {
      set({ launchError: (err as Error).message })
    } finally {
      set({ launching: false })
    }
  },

  closeSession: async (id) => {
    await window.acp.closeSession(id)
  },

  setActive: (id) => set({ activeId: id }),

  send: async (text) => {
    const { activeId } = get()
    if (!activeId || !text.trim()) return
    const content: ContentBlock[] = [{ type: 'text', text }]
    await window.acp.prompt(activeId, content)
  },

  cancel: () => {
    const { activeId } = get()
    if (activeId) void window.acp.cancel(activeId)
  },

  setConfigOption: async (optionId, value) => {
    const { activeId } = get()
    if (!activeId) return
    await window.acp.setConfigOption(activeId, optionId, value)
  },

  answerPermission: async (requestId, optionId) => {
    await window.acp.respondPermission(requestId, optionId)
  }
}))

export function useActiveSession(): SessionSnapshot | null {
  return useStore((s) => (s.activeId ? (s.sessions[s.activeId] ?? null) : null))
}

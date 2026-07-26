import { create } from 'zustand'

import type { ContentBlock } from '@shared/acp'
import type { AgentDefinition, MainEvent, SessionSnapshot, SkillInfo } from '@shared/ipc'
import { resolveSkillInvocation } from './slashMenu'

interface StoreState {
  sessions: Record<string, SessionSnapshot>
  order: string[]
  activeId: string | null
  agents: AgentDefinition[]
  /** Locally-loaded skills, per session — the agent does not advertise these. */
  skills: Record<string, SkillInfo[]>
  launching: boolean
  launchError: string | null
  loadSkills: (sessionId: string) => Promise<void>

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
  skills: {},
  launching: false,
  launchError: null,

  loadSkills: async (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session) return
    try {
      const skills = await window.acp.listSkills(session.cwd)
      set({ skills: { ...get().skills, [sessionId]: skills } })
    } catch {
      set({ skills: { ...get().skills, [sessionId]: [] } })
    }
  },

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
    for (const s of sessions) void get().loadSkills(s.id)
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
        void get().loadSkills(event.session.id)
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
    const state = get()
    const { activeId } = state
    if (!activeId || !text.trim()) return
    const session = state.sessions[activeId]

    // A leading /name that matches a locally-loaded skill is expanded here.
    // Uses the same resolver as the menu so the two can never disagree about
    // who owns a name.
    if (session) {
      const invocation = resolveSkillInvocation(
        text,
        session.commands,
        state.skills[activeId] ?? []
      )
      if (invocation) {
        const { skill, args } = invocation
        try {
          const { text: expanded } = await window.acp.expandSkill(
            session.cwd,
            skill.name,
            args
          )
          await window.acp.prompt(activeId, [{ type: 'text', text: expanded }], {
            text: text.trim(),
            skill: {
              name: skill.name,
              source: skill.source,
              expandedChars: expanded.length
            }
          })
          return
        } catch (err) {
          // Fall through and send verbatim rather than losing the message.
          console.error('skill expansion failed', err)
        }
      }
    }

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

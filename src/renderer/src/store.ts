import { create } from 'zustand'

import type { ContentBlock } from '@shared/acp'
import type {
  AgentDefinition,
  AttachmentMode,
  AttachmentSummary,
  MainEvent,
  SessionSnapshot,
  SkillInfo,
  ToolProfileInfo
} from '@shared/ipc'
import { getApi } from './api'
import { resolveSkillInvocation } from './slashMenu'

interface StoreState {
  sessions: Record<string, SessionSnapshot>
  order: string[]
  activeId: string | null
  agents: AgentDefinition[]
  /** Locally-loaded skills, per session — the agent does not advertise these. */
  skills: Record<string, SkillInfo[]>
  /** Staged attachments, per session, cleared when a prompt is sent. */
  attachments: Record<string, AttachmentSummary[]>
  /** Opaque host context keyed by working directory; core never reads it. */
  hostContexts: Record<string, unknown>
  launching: boolean
  launchError: string | null
  loadSkills: (sessionId: string) => Promise<void>
  addAttachments: (kind: 'file' | 'folder', mode?: AttachmentMode) => Promise<void>
  setAttachmentMode: (path: string, mode: AttachmentMode) => void
  removeAttachment: (path: string) => void
  refreshContext: () => Promise<void>
  restartSession: () => Promise<void>
  runCommand: (command: string) => Promise<void>

  bootstrap: () => Promise<void>
  applyEvent: (event: MainEvent) => void
  newSession: (cwd: string, agentId: string, toolProfile?: string) => Promise<void>
  toolProfiles: ToolProfileInfo[]
  closeSession: (id: string) => Promise<void>
  setActive: (id: string) => void
  send: (text: string) => Promise<void>
  cancel: () => void
  setConfigOption: (optionId: string, value: string, sessionId?: string) => Promise<void>
  answerPermission: (requestId: string, optionId: string | null) => Promise<void>
}

export const useStore = create<StoreState>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  agents: [],
  toolProfiles: [],
  skills: {},
  attachments: {},
  hostContexts: {},
  launching: false,
  launchError: null,

  loadSkills: async (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session) return
    try {
      const skills = await getApi().listSkills(session.cwd)
      set({ skills: { ...get().skills, [sessionId]: skills } })
    } catch {
      set({ skills: { ...get().skills, [sessionId]: [] } })
    }
  },

  bootstrap: async () => {
    const [agents, sessions, toolProfiles] = await Promise.all([
      getApi().listAgents(),
      getApi().listSessions(),
      getApi().listToolProfiles()
    ])
    set({
      agents,
      toolProfiles,
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
        const { [event.sessionId]: _skills, ...restSkills } = state.skills
        const { [event.sessionId]: _atts, ...restAtts } = state.attachments
        const order = state.order.filter((id) => id !== event.sessionId)
        set({
          sessions: rest,
          skills: restSkills,
          attachments: restAtts,
          order,
          activeId: state.activeId === event.sessionId ? (order[0] ?? null) : state.activeId
        })
        return
      }
      case 'session:activate': {
        // Only focus a session we actually know about; the event may arrive
        // before session:created on a cold open.
        if (state.sessions[event.sessionId]) set({ activeId: event.sessionId })
        return
      }
      case 'host:context': {
        set({ hostContexts: { ...state.hostContexts, [event.cwd]: event.context } })
        return
      }
      case 'session:turnEnded': {
        // Copilot never pushes token usage, so the meter is refreshed by
        // running /context and /usage once the turn releases the agent.
        void getApi().refreshContext(event.sessionId).catch(() => {})
        return
      }
      default:
        return
    }
  },

  newSession: async (cwd, agentId, toolProfile) => {
    set({ launching: true, launchError: null })
    try {
      await getApi().createSession({ cwd, agentId, toolProfile })
    } catch (err) {
      set({ launchError: (err as Error).message })
    } finally {
      set({ launching: false })
    }
  },

  closeSession: async (id) => {
    await getApi().closeSession(id)
  },

  setActive: (id) => set({ activeId: id }),

  send: async (text) => {
    const state = get()
    const { activeId } = state
    if (!activeId || !text.trim()) return
    const session = state.sessions[activeId]

    const attachments = (state.attachments[activeId] ?? []).map((a) => ({
      path: a.path,
      kind: a.kind,
      mode: a.mode
    }))

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
          const { text: expanded } = await getApi().expandSkill(
            session.cwd,
            skill.name,
            args
          )
          set({ attachments: { ...get().attachments, [activeId]: [] } })
          await getApi().prompt(activeId, {
            text: expanded,
            attachments,
            displayText: text.trim(),
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

    set({ attachments: { ...get().attachments, [activeId]: [] } })
    await getApi().prompt(activeId, { text, attachments })
  },

  /* ------------------------------------------------------------ attachments */

  addAttachments: async (kind, mode) => {
    const { activeId } = get()
    if (!activeId) return
    const paths =
      kind === 'file'
        ? await getApi().pickFiles()
        : await getApi().pickDirectory().then((d) => (d ? [d] : []))
    if (!paths.length) return

    const summaries = (await getApi().statPaths(paths)).map((s) =>
      s.kind === 'file' ? { ...s, mode: mode ?? 'full' } : s
    )
    const existing = get().attachments[activeId] ?? []
    const seen = new Set(existing.map((a) => a.path))
    set({
      attachments: {
        ...get().attachments,
        [activeId]: [...existing, ...summaries.filter((s) => !seen.has(s.path))]
      }
    })
  },

  setAttachmentMode: (path, mode) => {
    const { activeId, attachments } = get()
    if (!activeId) return
    set({
      attachments: {
        ...attachments,
        [activeId]: (attachments[activeId] ?? []).map((a) =>
          a.path === path ? { ...a, mode } : a
        )
      }
    })
  },

  removeAttachment: (path) => {
    const { activeId, attachments } = get()
    if (!activeId) return
    set({
      attachments: {
        ...attachments,
        [activeId]: (attachments[activeId] ?? []).filter((a) => a.path !== path)
      }
    })
  },

  /* -------------------------------------------------------- session actions */

  refreshContext: async () => {
    const { activeId } = get()
    if (!activeId) return
    await getApi().refreshContext(activeId)
  },

  restartSession: async () => {
    const { activeId } = get()
    if (!activeId) return
    await getApi().restartSession(activeId)
  },

  runCommand: async (command) => {
    const { activeId } = get()
    if (!activeId) return
    // Visible commands go through the normal prompt path so their output lands
    // in the transcript — /compact and /memory changes are real operations the
    // user should see a record of.
    await getApi().prompt(activeId, { text: command })
  },

  cancel: () => {
    const { activeId } = get()
    if (activeId) void getApi().cancel(activeId)
  },

  setConfigOption: async (optionId, value, sessionId) => {
    const target = sessionId ?? get().activeId
    if (!target) return
    try {
      await getApi().setConfigOption(target, optionId, value)
    } catch (error) {
      const current = get().sessions[target]
      if (!current) return
      const detail = error instanceof Error ? error.message : String(error)
      set({
        sessions: {
          ...get().sessions,
          [target]: {
            ...current,
            lastError: `Unable to change ${optionId}: ${detail}`
          }
        }
      })
    }
  },

  answerPermission: async (requestId, optionId) => {
    await getApi().respondPermission(requestId, optionId)
  }
}))

export function useActiveSession(): SessionSnapshot | null {
  return useStore((s) => (s.activeId ? (s.sessions[s.activeId] ?? null) : null))
}

/** Host context for a working directory, or null when the host pushed none. */
export function useHostContext(cwd: string | undefined): unknown {
  return useStore((s) => (cwd ? (s.hostContexts[cwd] ?? null) : null))
}

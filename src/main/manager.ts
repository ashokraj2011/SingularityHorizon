import { EventEmitter } from 'node:events'

import type { MainEvent, PersistedSession, PromptRequest, SessionSnapshot } from '../shared/ipc'
import { AgentSession } from './acp/session'
import { resolveAgent } from './agents'
import {
  deleteSession,
  exportAudit,
  listSessions as listPersistedSessions,
  readBlocks
} from './store/sessionStore'
import { collectContextDocuments } from './providers/registry'

/**
 * Owns every live agent session. Sessions are independent processes, so one
 * agent crashing never takes the others down.
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>()
  private providerContext = new Map<string, { phase?: string; hostContext?: unknown }>()
  /** requestId -> sessionId, so permission replies route without the caller knowing. */
  private permissionRoutes = new Map<string, string>()

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => s.getSnapshot())
  }

  async create(
    cwd: string,
    agentId: string,
    toolProfile?: string,
    providerContext: { phase?: string; hostContext?: unknown } = {}
  ): Promise<SessionSnapshot> {
    const [agent, contextDocuments] = await Promise.all([
      resolveAgent(agentId, toolProfile),
      collectContextDocuments(cwd, providerContext)
    ])
    const session = new AgentSession(agent, cwd, contextDocuments)

    session.on('event', (event: MainEvent) => {
      if (event.type === 'session:blocks') {
        for (const block of event.blocks) {
          if (block.kind === 'permission') {
            this.permissionRoutes.set(block.request.requestId, event.sessionId)
          }
        }
      }
      this.emit('event', event)
    })

    this.sessions.set(session.id, session)
    this.providerContext.set(session.id, providerContext)
    this.emit('event', { type: 'session:created', session: session.getSnapshot() })

    try {
      await session.start()
    } catch (err) {
      // Surface the failure on the session itself; the tab still exists so the
      // user can read the error instead of watching the window do nothing.
      this.emit('event', {
        type: 'session:patch',
        sessionId: session.id,
        patch: { status: 'error', lastError: (err as Error).message }
      })
    }

    return session.getSnapshot()
  }

  /** Sessions on disk, newest first, excluding ones already live. */
  async listPersisted(): Promise<PersistedSession[]> {
    const live = new Set([...this.sessions.values()].map((s) => s.id))
    const stored = await listPersistedSessions()
    return stored
      .filter((s) => !live.has(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Reopens a stored session.
   *
   * The transcript is restored from disk before the agent is contacted, so the
   * window shows the conversation immediately; the agent is then asked to
   * resume its own session, which is what preserves the model's context rather
   * than only the record of it. If the agent cannot resume, the transcript is
   * still there and the next turn simply starts a fresh agent context — a
   * degraded outcome, not a failed one.
   */
  async restore(id: string): Promise<SessionSnapshot | null> {
    const live = this.sessions.get(id)
    if (live) return live.getSnapshot()

    const stored = (await listPersistedSessions()).find((s) => s.id === id)
    if (!stored) return null

    const agent = await resolveAgent(stored.agentId, stored.toolProfile)
    // No context documents on restore: grounding was injected when the
    // session was first created and re-sending it would duplicate it.
    const session = new AgentSession(agent, stored.cwd, [], { id: stored.id })
    session.restoreBlocks(await readBlocks(id), stored.turns)

    this.wire(session)
    this.sessions.set(session.id, session)
    this.emit('event', { type: 'session:created', session: session.getSnapshot() })

    try {
      await session.start(stored.acpSessionId)
    } catch (err) {
      this.emit('event', {
        type: 'session:patch',
        sessionId: session.id,
        patch: { status: 'error', lastError: (err as Error).message }
      })
    }
    return session.getSnapshot()
  }

  forget(id: string): Promise<void> {
    return deleteSession(id)
  }

  audit(id: string): ReturnType<typeof exportAudit> {
    return exportAudit(id)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.dispose()
    this.sessions.delete(sessionId)
    this.providerContext.delete(sessionId)
    this.emit('event', { type: 'session:removed', sessionId })
  }

  prompt(sessionId: string, request: PromptRequest): Promise<void> {
    return this.require(sessionId).prompt(request)
  }

  runCommandSilent(sessionId: string, command: string): Promise<string> {
    return this.require(sessionId).runCommandSilent(command)
  }

  refreshContext(sessionId: string): Promise<void> {
    return this.require(sessionId).refreshContext()
  }

  /**
   * Replaces a session with a fresh one on the same cwd and agent. This is the
   * real "start over" — a new ACP session means new agent context, which no
   * amount of /compact achieves.
   */
  async restart(sessionId: string): Promise<SessionSnapshot | null> {
    const existing = this.sessions.get(sessionId)
    if (!existing) return null
    const { cwd, agent } = existing
    const providerContext = this.providerContext.get(sessionId)
    this.close(sessionId)
    // Carry the tool profile over — restarting is meant to clear context, not
    // silently re-inflate it back to the full toolset.
    return this.create(cwd, agent.id, agent.toolProfile, providerContext)
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.cancel()
  }

  setConfigOption(sessionId: string, optionId: string, value: string): Promise<void> {
    return this.require(sessionId).setConfigOption(optionId, value)
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const sessionId = this.permissionRoutes.get(requestId)
    if (!sessionId) return
    this.permissionRoutes.delete(requestId)
    this.sessions.get(sessionId)?.resolvePermission(requestId, optionId)
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    this.providerContext.clear()
  }

  /** Routes a session's events outward and tracks its permission requests. */
  private wire(session: AgentSession): void {
    session.on('event', (event: MainEvent) => {
      if (event.type === 'session:blocks') {
        for (const block of event.blocks) {
          if (block.kind === 'permission') {
            this.permissionRoutes.set(block.request.requestId, event.sessionId)
          }
        }
      }
      this.emit('event', event)
    })
  }

  private require(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    return session
  }
}

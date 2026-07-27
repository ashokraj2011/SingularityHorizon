import { EventEmitter } from 'node:events'

import type { MainEvent, PromptRequest, SessionSnapshot } from '../shared/ipc'
import { AgentSession } from './acp/session'
import { resolveAgent } from './agents'
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

  private require(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    return session
  }
}

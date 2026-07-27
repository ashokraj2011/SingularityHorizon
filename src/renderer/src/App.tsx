import { useCallback, useEffect, useState } from 'react'

import { Composer } from './components/Composer'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import { TopBar } from './components/TopBar'
import { getApi } from './api'
import { useActiveSession, useStore } from './store'

export function App(): React.JSX.Element {
  const { bootstrap, applyEvent, agents, newSession, launching, launchError, cancel } = useStore()
  const session = useActiveSession()
  const [agentId, setAgentId] = useState('copilot')
  // Tool profile is a spawn flag, so it must be chosen before the session
  // exists — it cannot be changed on a live one.
  const [toolProfile, setToolProfile] = useState('full')
  const toolProfiles = useStore((s) => s.toolProfiles)

  useEffect(() => {
    void bootstrap()
    return getApi().onEvent(applyEvent)
  }, [bootstrap, applyEvent])

  const startSession = useCallback(async () => {
    const dir = await getApi().pickDirectory()
    if (!dir) return
    await newSession(dir, agentId, toolProfile)
  }, [agentId, toolProfile, newSession])

  // Esc interrupts the running turn from anywhere in the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && session?.status === 'busy') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session?.status, cancel])

  return (
    <div className="app">
      <Sidebar onNew={startSession} />

      <main className="main">
        {session ? (
          <>
            <TopBar session={session} />
            <Thread session={session} />
            <Composer session={session} />
          </>
        ) : (
          <>
            <header className="topbar">
              <span className="spacer" />
            </header>
            <div className="empty">
              <div className="wordmark">Singularity</div>
              <h1>Event Horizon</h1>
              <p>
                Where your intent crosses into execution. Pick a folder to start a session — the
                coding agent runs as its own process, scoped to that directory, and every action
                it takes crosses back through you first.
              </p>
              <div className="empty-row">
                <select
                  className="select"
                  style={{ maxWidth: 240 }}
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {agentId === 'copilot' && toolProfiles.length > 0 && (
                  <select
                    className="select"
                    style={{ maxWidth: 220 }}
                    title={
                      toolProfiles.find((p) => p.id === toolProfile)?.description ??
                      'How many tools the agent gets'
                    }
                    value={toolProfile}
                    onChange={(e) => setToolProfile(e.target.value)}
                  >
                    {toolProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.measuredOverhead
                          ? ` · ~${Math.round(p.measuredOverhead / 1000)}k`
                          : ''}
                      </option>
                    ))}
                  </select>
                )}
                <button className="btn primary" onClick={startSession} disabled={launching}>
                  {launching ? 'Starting…' : 'Open a folder'}
                </button>
              </div>
              {agentId === 'copilot' && (
                <p style={{ fontSize: 12, color: 'var(--text-faint)', maxWidth: 470 }}>
                  {toolProfiles.find((p) => p.id === toolProfile)?.description}
                  {toolProfile !== 'full' &&
                    ' Tool definitions are re-sent every request, so this compounds — at the cost of what the agent can do directly.'}
                </p>
              )}
              {launchError && (
                <div className="notice error" style={{ maxWidth: 520 }}>
                  {launchError}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

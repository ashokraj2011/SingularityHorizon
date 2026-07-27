import { useEffect, useRef, useState } from 'react'

import type { SessionSnapshot } from '@shared/ipc'
import { formatTokens } from '@shared/contextInfo'
import { useStore } from '../store'
import { ContextPanel } from './ContextPanel'

export function TopBar({ session }: { session: SessionSnapshot }): React.JSX.Element {
  const setConfigOption = useStore((s) => s.setConfigOption)
  const restartSession = useStore((s) => s.restartSession)
  const runCommand = useStore((s) => s.runCommand)
  const refreshContext = useStore((s) => s.refreshContext)

  const [menuOpen, setMenuOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const allowAllOption = session.configOptions.find((o) => o.id === 'allow_all')
  const allowAllOn = allowAllOption?.currentValue === 'on'
  const ctx = session.context
  const home = session.cwd.replace(/^\/Users\/[^/]+/, '~')
  const busy = session.status === 'busy'

  const act = (fn: () => void): void => {
    setMenuOpen(false)
    fn()
  }

  return (
    <header className="topbar">
      <span className={`dot ${session.status}`} />
      <span className="cwd" title={session.cwd}>
        {home}
      </span>

      <span className="spacer" />

      {ctx && (
        <button
          className="meter"
          title={`Context: ${formatTokens(ctx.usedTokens)} of ${formatTokens(
            ctx.totalTokens
          )} tokens (${ctx.percent}%). Click for the breakdown.`}
          onClick={() => setPanelOpen(true)}
        >
          <span className="meter-bar">
            <span
              className={`meter-fill ${ctx.percent >= 80 ? 'hot' : ctx.percent >= 60 ? 'warm' : ''}`}
              style={{ width: `${Math.min(100, Math.max(2, ctx.percent))}%` }}
            />
          </span>
          <span className="meter-label">
            {formatTokens(ctx.usedTokens)}/{formatTokens(ctx.totalTokens)}
          </span>
        </button>
      )}

      {session.toolProfile && session.toolProfile !== 'full' && (
        <span
          className="pill"
          title="Tool profile chosen when this session started. Fixed for its lifetime — start a new session to change it."
        >
          {session.toolProfile}
        </span>
      )}

      {allowAllOption && (
        <button
          className={`pill toggle ${allowAllOn ? 'on' : ''}`}
          title={
            allowAllOption.description ??
            'Approve all tool, path, and URL requests without asking'
          }
          onClick={() => void setConfigOption('allow_all', allowAllOn ? 'off' : 'on')}
        >
          {allowAllOn ? 'Allow all: on' : 'Allow all'}
        </button>
      )}

      <div className="menu-wrap" ref={menuRef}>
        <button
          className="icon-btn"
          title="Session actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="drop">
            <div className="drop-label">Context</div>
            <button className="menu-item" onClick={() => act(() => setPanelOpen(true))}>
              Show context breakdown
            </button>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void refreshContext())}
            >
              Refresh usage
            </button>
            <button
              className="menu-item"
              disabled={busy}
              title="Ask the agent to summarize the conversation so far, freeing context"
              onClick={() => act(() => void runCommand('/compact'))}
            >
              Compact conversation
            </button>

            <div className="drop-sep" />
            <div className="drop-label">Agent memory</div>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void runCommand('/memory show'))}
            >
              Show memory status
            </button>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void runCommand('/memory on'))}
            >
              Enable memory
            </button>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void runCommand('/memory off'))}
            >
              Disable memory
            </button>

            <div className="drop-sep" />
            <div className="drop-label">Session</div>
            <button
              className="menu-item"
              title="Close this session and open a new one on the same folder. Clears all agent context."
              onClick={() => act(() => void restartSession())}
            >
              Start fresh session
            </button>
          </div>
        )}
      </div>

      {panelOpen && <ContextPanel session={session} onClose={() => setPanelOpen(false)} />}
    </header>
  )
}

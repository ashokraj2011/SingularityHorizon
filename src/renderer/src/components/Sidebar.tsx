import { useState } from 'react'

import { AuditPanel } from './AuditPanel'
import { useStore } from '../store'

export function Sidebar({ onNew }: { onNew: () => void }): React.JSX.Element {
  const {
    order,
    sessions,
    activeId,
    setActive,
    closeSession,
    persisted,
    restoreSession,
    forgetSession
  } = useStore()
  const [auditId, setAuditId] = useState<string | null>(null)

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />

      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Event Horizon</span>
        <span className="brand-suite">Singularity</span>
      </div>

      <div className="sidebar-section">
        <button className="btn wide" onClick={onNew}>
          + New session
        </button>
      </div>

      <div className="sidebar-label">Sessions</div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 12px' }}>
        {order.length === 0 && (
          <div style={{ padding: '4px 8px', color: 'var(--text-faint)', fontSize: 12.5 }}>
            No sessions yet.
          </div>
        )}
        {order.map((id) => {
          const s = sessions[id]
          if (!s) return null
          return (
            <div
              key={id}
              className={`session-item ${id === activeId ? 'active' : ''}`}
              onClick={() => setActive(id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setActive(id)}
            >
              <span className={`dot ${s.status}`} title={s.status} />
              <span className="name" title={s.cwd}>
                {s.title}
              </span>
              <button
                className="close"
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeSession(id)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}

        {persisted.length > 0 && (
          <>
            <div className="sidebar-label" style={{ paddingLeft: 8 }}>
              Earlier
            </div>
            {persisted.slice(0, 30).map((s) => (
              <div
                key={s.id}
                className="session-item"
                title={`${s.cwd}\n${s.turns} turn${s.turns === 1 ? '' : 's'} · ${new Date(s.updatedAt).toLocaleString()}`}
                role="button"
                tabIndex={0}
                onClick={() => void restoreSession(s.id)}
                onKeyDown={(e) => e.key === 'Enter' && void restoreSession(s.id)}
              >
                <span className="dot" />
                <span className="name">
                  {s.title}
                  {s.lastMessage && (
                    <span className="sub"> — {s.lastMessage}</span>
                  )}
                </span>
                <button
                  className="close"
                  title="Audit record — what the agent was allowed to do"
                  onClick={(e) => {
                    e.stopPropagation()
                    setAuditId(s.id)
                  }}
                >
                  ⎘
                </button>
                <button
                  className="close"
                  title="Delete this session and its transcript"
                  onClick={(e) => {
                    e.stopPropagation()
                    void forgetSession(s.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {auditId && <AuditPanel sessionId={auditId} onClose={() => setAuditId(null)} />}
    </aside>
  )
}

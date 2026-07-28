import { useEffect, useState } from 'react'

import type { AuditRecord } from '@shared/ipc'
import { getApi } from '../api'

/**
 * The record of what an agent was allowed to do.
 *
 * This is the artefact that makes the permission gate worth having: every
 * request, the exact command, and the answer a person gave. It reads from the
 * transcript, so it works for a closed session as well as a live one.
 */
export function AuditPanel({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const [record, setRecord] = useState<AuditRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    getApi()
      .exportAudit(sessionId)
      .then((r) => !cancelled && setRecord(r))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const save = async (format: 'json' | 'markdown'): Promise<void> => {
    try {
      const path = await getApi().saveAudit(sessionId, format)
      if (path) setSaved(path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const when = (ms: number): string => new Date(ms).toLocaleString()
  const denied = record?.approvals.filter((a) => /den|reject|cancel/i.test(a.decision)) ?? []
  const blanket = record?.approvals.filter((a) => /always/i.test(a.decision)) ?? []

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>Audit record</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="sheet-body">
          {error && <div className="notice error">{error}</div>}
          {!record && !error && <div className="sheet-empty">Reading the transcript…</div>}

          {record && (
            <>
              <div className="audit-stats">
                <Stat label="Permission requests" value={record.approvals.length} />
                <Stat
                  label="Denied or cancelled"
                  value={denied.length}
                  tone={denied.length ? 'red' : undefined}
                />
                <Stat
                  label="Blanket grants"
                  value={blanket.length}
                  tone={blanket.length ? 'yellow' : undefined}
                />
                <Stat label="Tool invocations" value={record.commands.length} />
              </div>

              {record.session && (
                <div className="sheet-row-head">
                  {record.session.cwd} · {record.session.agentId}
                  {record.session.toolProfile ? ` · ${record.session.toolProfile} tools` : ''} ·{' '}
                  {record.session.turns} turn{record.session.turns === 1 ? '' : 's'}
                </div>
              )}

              <div className="sheet-sep" />
              <div className="sheet-row-head">Permission decisions</div>
              {record.approvals.length === 0 ? (
                <div className="sheet-empty">
                  Nothing required approval in this session.
                </div>
              ) : (
                <table className="ctx-table audit-table">
                  <tbody>
                    {record.approvals.map((a, i) => (
                      <tr key={i}>
                        <td className="dim nowrap">{when(a.at)}</td>
                        <td>
                          <span
                            className={`decision ${
                              /den|reject|cancel/i.test(a.decision)
                                ? 'no'
                                : /always/i.test(a.decision)
                                  ? 'always'
                                  : 'yes'
                            }`}
                          >
                            {a.decision}
                          </span>
                        </td>
                        <td>
                          {a.title}
                          {a.command && <div className="cmd">$ {a.command}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="sheet-sep" />
              <div className="sheet-row-head">Tool invocations</div>
              {record.commands.length === 0 ? (
                <div className="sheet-empty">No tools were invoked.</div>
              ) : (
                <table className="ctx-table audit-table">
                  <tbody>
                    {record.commands.map((c, i) => (
                      <tr key={i}>
                        <td className="dim nowrap">{when(c.at)}</td>
                        <td className={`nowrap ${c.status === 'failed' ? 'bad' : ''}`}>
                          {c.status ?? '—'}
                        </td>
                        <td>
                          <span className="cmd">{c.command}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>

        <div className="sheet-foot">
          {saved && <span className="hint">Saved to {saved}</span>}
          <span className="spacer" />
          <button className="btn" disabled={!record} onClick={() => void save('json')}>
            Export JSON
          </button>
          <button className="btn primary" disabled={!record} onClick={() => void save('markdown')}>
            Export report
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone?: 'red' | 'yellow'
}): React.JSX.Element {
  return (
    <div className="audit-stat">
      <div className={`audit-stat-value ${tone ?? ''}`}>{value}</div>
      <div className="audit-stat-label">{label}</div>
    </div>
  )
}

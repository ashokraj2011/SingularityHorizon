import { useEffect, useState } from 'react'

import type { UsageBucket, UsageSummary } from '@shared/ipc'
import { formatTokens } from '@shared/contextInfo'
import { getApi } from '../api'

/**
 * Spend across every session, not just this one.
 *
 * Weighted requests lead because that is the figure that tracks the bill:
 * Copilot charges premium requests with a per-model multiplier, so ten Opus
 * requests cost 45× ten Haiku ones. Raw tokens are shown too, but they measure
 * context pressure, which is a different problem with a different fix.
 */
export function UsagePanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      .usageSummary()
      .then((s) => !cancelled && setSummary(s))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>Usage across sessions</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="sheet-body">
          {error && <div className="notice error">{error}</div>}
          {!summary && !error && <div className="sheet-empty">Reading session history…</div>}

          {summary && (
            <>
              <div className="audit-stats">
                <Stat
                  label="Weighted requests"
                  value={round(summary.totalWeightedRequests)}
                  hint="Requests × each model's cost multiplier"
                />
                <Stat label="Raw requests" value={summary.totalRequests} />
                <Stat label="Input tokens" value={formatTokens(summary.totalInputTokens)} />
                <Stat label="Cached" value={formatTokens(summary.totalCachedTokens)} />
              </div>

              {summary.partial && (
                <div className="notice">
                  {summary.totalSessions - summary.sessionsWithUsage} of{' '}
                  {summary.totalSessions} sessions have no usage reading — these totals are a
                  floor, not a complete figure. A session reports usage once it has run a turn.
                </div>
              )}

              <Table
                title="By model"
                buckets={summary.byModel}
                showMultiplier
                empty="No sessions recorded yet."
              />
              <Table title="By repository" buckets={summary.byRepo} empty="" />
              <Table title="By day" buckets={summary.byDay} empty="" />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Table({
  title,
  buckets,
  showMultiplier,
  empty
}: {
  title: string
  buckets: UsageBucket[]
  showMultiplier?: boolean
  empty: string
}): React.JSX.Element | null {
  if (!buckets.length) return empty ? <div className="sheet-empty">{empty}</div> : null
  return (
    <>
      <div className="sheet-sep" />
      <div className="sheet-row-head">{title}</div>
      <table className="ctx-table audit-table">
        <tbody>
          {buckets.map((b) => (
            <tr key={b.key}>
              <td title={b.key}>
                {b.label}
                {showMultiplier && b.multiplier && (
                  <span className="mult">{b.multiplier}</span>
                )}
              </td>
              <td className="num">{round(b.weightedRequests)}</td>
              <td className="num dim">{b.requests} req</td>
              <td className="num dim">{formatTokens(b.inputTokens)} in</td>
              <td className="num dim">
                {b.sessions} session{b.sessions === 1 ? '' : 's'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function Stat({
  label,
  value,
  hint
}: {
  label: string
  value: number | string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="audit-stat" title={hint}>
      <div className="audit-stat-value">{value}</div>
      <div className="audit-stat-label">{label}</div>
    </div>
  )
}

import { useEffect } from 'react'

import type { SessionSnapshot } from '@shared/ipc'
import { formatTokens } from '@shared/contextInfo'

/**
 * The full context-window breakdown, plus session token accounting.
 *
 * Both come from parsing `/context` and `/usage`; if either parse failed the
 * section says so rather than showing zeros, since a silently-zeroed meter
 * reads as "nothing used" when the truth is "we couldn't tell".
 */
export function ContextPanel({
  session,
  onClose
}: {
  session: SessionSnapshot
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ctx = session.context
  const usage = session.usage

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>Context &amp; usage</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="sheet-body">
          {ctx ? (
            <>
              <div className="sheet-row-head">
                <span>
                  {ctx.model ?? 'context window'} —{' '}
                  <strong>
                    {formatTokens(ctx.usedTokens)} / {formatTokens(ctx.totalTokens)}
                  </strong>{' '}
                  ({ctx.percent}%)
                </span>
              </div>

              <div className="stack">
                {ctx.slices.map((s) => (
                  <div className="stack-seg" key={s.label} title={`${s.label}: ${formatTokens(s.tokens)}`}>
                    <span
                      className={`seg ${slug(s.label)}`}
                      style={{ width: `${Math.max(0.4, s.percent)}%` }}
                    />
                  </div>
                ))}
              </div>

              <table className="ctx-table">
                <tbody>
                  {ctx.slices.map((s) => (
                    <tr key={s.label}>
                      <td>
                        <span className={`swatch ${slug(s.label)}`} />
                        {s.label}
                      </td>
                      <td className="num">{formatTokens(s.tokens)}</td>
                      <td className="num dim">
                        {s.percent < 1 ? '<1' : Math.round(s.percent)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="sheet-empty">
              No context reading yet. Copilot only reports context after the first
              real message in a session — send one, then reopen this.
            </div>
          )}

          <div className="sheet-sep" />

          <div className="sheet-row-head">
            <span>Session totals</span>
          </div>
          {usage ? (
            <table className="ctx-table">
              <tbody>
                {usage.inputTokens !== undefined && (
                  <tr>
                    <td>Input</td>
                    <td className="num">{formatTokens(usage.inputTokens)}</td>
                    <td />
                  </tr>
                )}
                {usage.cachedTokens !== undefined && (
                  <tr>
                    <td>Cached</td>
                    <td className="num">{formatTokens(usage.cachedTokens)}</td>
                    <td />
                  </tr>
                )}
                {usage.outputTokens !== undefined && (
                  <tr>
                    <td>Output</td>
                    <td className="num">{formatTokens(usage.outputTokens)}</td>
                    <td />
                  </tr>
                )}
                {usage.reasoningTokens !== undefined && (
                  <tr>
                    <td>Reasoning</td>
                    <td className="num">{formatTokens(usage.reasoningTokens)}</td>
                    <td />
                  </tr>
                )}
                {usage.requests !== undefined && (
                  <tr>
                    <td>Requests</td>
                    <td className="num">{usage.requests}</td>
                    <td className="num dim">AI units</td>
                  </tr>
                )}
                {(usage.linesAdded !== undefined || usage.linesRemoved !== undefined) && (
                  <tr>
                    <td>Changes</td>
                    <td className="num" style={{ color: 'var(--green)' }}>
                      +{usage.linesAdded ?? 0}
                    </td>
                    <td className="num" style={{ color: 'var(--red)' }}>
                      -{usage.linesRemoved ?? 0}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <div className="sheet-empty">No usage reported yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z]+/g, '-')
}

import { useEffect } from 'react'

import type { PendingPermission } from '@shared/ipc'
import { useStore } from '../store'

/**
 * Inline approval card. Nothing runs until the user picks an option, and the
 * card stays in the transcript afterwards showing what was chosen — the record
 * of what you approved is as important as the prompt itself.
 */
export function PermissionCard({ request }: { request: PendingPermission }): React.JSX.Element {
  const answer = useStore((s) => s.answerPermission)
  const resolved = request.resolvedOptionId !== undefined || request.cancelled
  const command =
    typeof request.toolCall.rawInput?.command === 'string'
      ? request.toolCall.rawInput.command
      : null

  // "Allow all" is a real session config option Copilot exposes (id: allow_all,
  // category: permissions) — once set to "on" the agent stops calling
  // session/request_permission at all. Distinct from "always allow <tool>",
  // which only allowlists this one command; this is a global bypass, so it
  // gets its own explicit action rather than piggybacking on an agent option.
  const allowAll = (): void => {
    const fallback = request.options.find((o) => o.kind === 'allow_once') ?? request.options[0]
    if (!fallback) return
    void window.acp.setConfigOption(request.sessionId, 'allow_all', 'on')
    void answer(request.requestId, fallback.optionId)
  }

  // Keyboard shortcuts mirror the CLI: y allows once, a always, n denies,
  // shift+A allows all.
  useEffect(() => {
    if (resolved) return
    const byKind = (kind: string): string | undefined =>
      request.options.find((o) => o.kind === kind)?.optionId

    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        allowAll()
        return
      }
      const map: Record<string, string | undefined> = {
        y: byKind('allow_once'),
        a: byKind('allow_always'),
        n: byKind('reject_once')
      }
      const optionId = map[e.key.toLowerCase()]
      if (optionId) {
        e.preventDefault()
        void answer(request.requestId, optionId)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        void answer(request.requestId, null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resolved, request, answer])

  const chosen = request.options.find((o) => o.optionId === request.resolvedOptionId)

  return (
    <div className="perm">
      <div className="perm-head">Permission required</div>
      <div className="perm-body">
        <div style={{ fontSize: 13, marginBottom: command ? 7 : 0 }}>
          {request.toolCall.title || request.toolCall.kind || 'Run tool'}
        </div>
        {command && <div className="cmd">$ {command}</div>}
      </div>

      {resolved ? (
        <div className="perm-resolved">
          {request.cancelled ? 'Cancelled' : `Answered: ${chosen?.name ?? 'unknown'}`}
        </div>
      ) : (
        <div className="perm-actions">
          {request.options.map((opt) => (
            <button
              key={opt.optionId}
              className={`btn ${opt.kind === 'allow_once' ? 'primary' : ''}`}
              onClick={() => void answer(request.requestId, opt.optionId)}
            >
              {opt.name}
              <kbd style={{ opacity: 0.55, fontSize: 11 }}>{hint(opt.kind)}</kbd>
            </button>
          ))}
          <span className="spacer" />
          <button
            className="btn allow-all"
            title="Approve this and stop asking for the rest of the session"
            onClick={allowAll}
          >
            Allow all
            <kbd style={{ opacity: 0.7, fontSize: 11 }}>⇧A</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

function hint(kind: string | undefined): string {
  if (kind === 'allow_once') return 'Y'
  if (kind === 'allow_always') return 'A'
  if (kind === 'reject_once') return 'N'
  return ''
}

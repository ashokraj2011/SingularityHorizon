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

  // Keyboard shortcuts mirror the CLI: y allows once, a always, n denies.
  useEffect(() => {
    if (resolved) return
    const byKind = (kind: string): string | undefined =>
      request.options.find((o) => o.kind === kind)?.optionId

    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
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

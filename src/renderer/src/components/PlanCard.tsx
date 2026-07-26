import type { PlanEntry } from '@shared/acp'

const MARK: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●'
}

export function PlanCard({ entries }: { entries: PlanEntry[] }): React.JSX.Element {
  const done = entries.filter((e) => e.status === 'completed').length
  return (
    <div className="plan">
      <div className="plan-title">
        Plan · {done}/{entries.length}
      </div>
      {entries.map((entry, i) => (
        <div className={`plan-item ${entry.status}`} key={i}>
          <span className="mark">{MARK[entry.status] ?? '○'}</span>
          <span className="label">{entry.content}</span>
        </div>
      ))}
    </div>
  )
}

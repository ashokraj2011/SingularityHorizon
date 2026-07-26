import type { SessionSnapshot } from '@shared/ipc'
import { useStore } from '../store'

/** Config options worth surfacing in the header; the rest live in the menu. */
const PRIMARY = ['mode', 'model', 'reasoning_effort']

export function TopBar({ session }: { session: SessionSnapshot }): React.JSX.Element {
  const setConfigOption = useStore((s) => s.setConfigOption)

  const primary = PRIMARY.map((id) => session.configOptions.find((o) => o.id === id)).filter(
    (o): o is NonNullable<typeof o> => !!o && !!o.options?.length
  )

  const home = session.cwd.replace(/^\/Users\/[^/]+/, '~')

  return (
    <header className="topbar">
      <span className={`dot ${session.status}`} />
      <span className="cwd" title={session.cwd}>
        {home}
      </span>

      <span className="spacer" />

      {session.usage?.totalTokens != null && (
        <span className="pill" title="Tokens used this session">
          {formatTokens(session.usage.totalTokens)}
          {session.usage.contextWindow
            ? ` / ${formatTokens(session.usage.contextWindow)}`
            : ' tokens'}
        </span>
      )}

      {primary.map((option) => (
        <select
          key={option.id}
          className="select"
          title={option.description ?? option.name}
          value={option.currentValue ?? ''}
          onChange={(e) => void setConfigOption(option.id, e.target.value)}
        >
          {option.options!.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {option.id === 'reasoning_effort' ? `effort: ${choice.name}` : choice.name}
            </option>
          ))}
        </select>
      ))}

      {session.agentName && (
        <span className="pill" title={`${session.agentName} ${session.agentVersion ?? ''}`}>
          {session.agentName}
        </span>
      )}
    </header>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

import type { SessionConfigOption } from '@shared/acp'
import { useStore } from '../store'

/**
 * A single agent-declared config option rendered as a native select.
 *
 * These are entirely data-driven: Copilot declares mode / model /
 * reasoning_effort / agent / allow_all with their own labels and descriptions,
 * so nothing here is hard-coded to a known set. An agent that adds a sixth
 * option gets a working picker with no code change.
 */
export function ConfigPicker({
  option,
  sessionId,
  prefix
}: {
  option: SessionConfigOption
  sessionId: string
  prefix?: string
}): React.JSX.Element | null {
  const setConfigOption = useStore((s) => s.setConfigOption)
  if (!option.options?.length) return null

  return (
    <select
      className="select"
      title={option.description ?? option.name}
      value={option.currentValue ?? ''}
      onChange={(e) => void setConfigOption(option.id, e.target.value, sessionId)}
    >
      {option.options.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {prefix ? `${prefix}${choice.name}` : choice.name}
        </option>
      ))}
    </select>
  )
}

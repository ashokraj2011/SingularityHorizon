import type { ConfigOptionChoice, SessionConfigOption } from '@shared/acp'
import { useStore } from '../store'

/**
 * Copilot reports a billing multiplier per model in `_meta.copilotUsage`
 * ("0.33x" for Haiku, "15x" for Opus — a 45x spread). Copilot bills premium
 * requests rather than tokens, so this multiplier, not context size, is what
 * actually shows up on the bill. It was already on the wire and invisible;
 * showing it makes the expensive choice a deliberate one.
 */
function costSuffix(choice: ConfigOptionChoice): string {
  const usage = choice._meta?.copilotUsage
  return typeof usage === 'string' && usage !== '1x' ? `  ·  ${usage}` : ''
}

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
          {costSuffix(choice)}
        </option>
      ))}
    </select>
  )
}

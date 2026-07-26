import type { AvailableCommand } from '@shared/acp'
import type { SkillInfo } from '@shared/ipc'

export interface SlashItem {
  key: string
  label: string
  description?: string
  /** Which plugin or scope a skill came from; absent for agent commands. */
  badge?: string
  insert: string
  /** True when this client expands the skill locally before sending. */
  local: boolean
}

/**
 * Merges the agent's advertised slash commands with skills this client loaded
 * from disk.
 *
 * Kept as a pure function so the precedence rules are testable without a
 * renderer: the agent always owns a name it advertises, and skills only fill
 * the gaps. Getting that backwards would shadow a real agent command with a
 * local file, which is the one failure mode that would silently change what
 * the agent does.
 */
export function buildSlashItems(
  commands: AvailableCommand[],
  skills: SkillInfo[],
  query: string
): SlashItem[] {
  const q = query.toLowerCase()

  const fromAgent: SlashItem[] = commands
    .filter((c) => c.name.toLowerCase().includes(q))
    .map((c) => ({
      key: `cmd:${c.name}`,
      label: `/${c.name}`,
      description: c.description,
      insert: `/${c.name} `,
      local: false
    }))

  const agentNames = new Set(commands.map((c) => c.name))
  const fromSkills: SlashItem[] = skills
    .filter((s) => !agentNames.has(s.name) && s.name.toLowerCase().includes(q))
    .map((s) => ({
      key: `skill:${s.name}`,
      label: `/${s.name}`,
      description: s.description || s.argumentHint,
      badge: s.source,
      insert: `/${s.name} `,
      local: true
    }))

  // Skills first once the user has typed something: if they type `/sflow` they
  // mean a skill, and burying it under 32 built-ins helps nobody. With an empty
  // query the built-ins lead, since that is the agent's own surface.
  const merged = q ? [...fromSkills, ...fromAgent] : [...fromAgent, ...fromSkills]
  return merged.slice(0, 40)
}

/**
 * Decides whether a message is a local skill invocation. Returns null when the
 * text should be sent to the agent verbatim.
 */
export function resolveSkillInvocation(
  text: string,
  commands: AvailableCommand[],
  skills: SkillInfo[]
): { skill: SkillInfo; args: string } | null {
  const match = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim())
  if (!match) return null
  if (commands.some((c) => c.name === match[1])) return null // agent owns it
  const skill = skills.find((s) => s.name === match[1])
  return skill ? { skill, args: match[2] } : null
}

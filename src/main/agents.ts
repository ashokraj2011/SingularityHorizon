import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import type { AgentDefinition } from '../shared/ipc'

const execFileAsync = promisify(execFile)

/**
 * A GUI-launched macOS app inherits launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), not the one from the user's shell profile.
 * Homebrew, nvm, pnpm and asdf installs are all invisible under that PATH, so
 * `copilot` resolves fine in a terminal and mysteriously fails in the packaged
 * app. Ask the login shell for its real PATH once and cache it.
 */
let cachedPath: string | undefined

export async function resolvedPath(): Promise<string> {
  if (cachedPath) return cachedPath

  const fallbacks = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
    join(homedir(), 'Library/pnpm'),
    join(homedir(), '.cargo/bin')
  ]

  let shellPath = ''
  const shell = process.env.SHELL
  if (shell && process.platform !== 'win32') {
    try {
      // -i so ~/.zshrc (where most PATH edits live) is sourced.
      const { stdout } = await execFileAsync(shell, ['-ilc', 'printf %s "$PATH"'], {
        timeout: 5000
      })
      shellPath = stdout.trim()
    } catch {
      shellPath = ''
    }
  }

  const merged = [
    ...(shellPath ? shellPath.split(delimiter) : []),
    ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
    ...fallbacks
  ]
  cachedPath = [...new Set(merged.filter(Boolean))].join(delimiter)
  return cachedPath
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a bare command name to an absolute path using the real PATH. */
export async function which(command: string): Promise<string | null> {
  if (isAbsolute(command)) return isExecutable(command) ? command : null
  const path = await resolvedPath()
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * Tool profiles trade agent capability for context.
 *
 * Tool definitions are re-sent on every request and dominate a session's fixed
 * cost. Measured against Copilot 1.0.75 (`/context` after one message, same
 * cwd, same model):
 *
 *   full          System Prompt 5.8k + Tools 8.1k + MCP 0.9k  = 14,839
 *   no MCP        System Prompt 5.5k + Tools 8.1k + MCP   0   = 13,600
 *   lean          System Prompt 3.4k + Tools 0.9k + MCP   0   =  4,306
 *   minimal       System Prompt 3.5k + Tools 0.6k + MCP   0   =  4,068
 *
 * Lean is a 71% cut in per-request overhead. The system prompt shrinks too,
 * because it describes the available tools — the saving compounds.
 *
 * These are spawn flags, not session config: ACP has no way to change them on
 * a live session, so the choice is made when the session is created.
 *
 * Restricting tools is a real capability tradeoff, not free money. `bash` alone
 * can do most things a shell can, but the agent loses purpose-built file
 * editing and search, and may burn extra turns reimplementing them. Full is the
 * default for that reason; the leaner profiles are for long sessions where
 * context pressure matters more than breadth.
 */
export interface ToolProfile {
  id: string
  name: string
  description: string
  extraArgs: string[]
  /** Measured fixed overhead in tokens, for display. */
  measuredOverhead?: number
}

export const TOOL_PROFILES: ToolProfile[] = [
  {
    id: 'full',
    name: 'Full',
    description: 'Every tool the agent ships with. Most capable, largest context cost.',
    extraArgs: [],
    measuredOverhead: 14839
  },
  {
    id: 'no-mcp',
    name: 'No MCP',
    description: 'Built-in tools, but no MCP servers. Small saving, no capability loss.',
    extraArgs: ['--disable-builtin-mcps'],
    measuredOverhead: 13600
  },
  {
    id: 'lean',
    name: 'Lean (bash + view)',
    description: 'Shell and file reading only. ~71% less fixed overhead per request.',
    extraArgs: ['--available-tools=bash,view', '--disable-builtin-mcps'],
    measuredOverhead: 4306
  },
  {
    id: 'minimal',
    name: 'Minimal (bash)',
    description: 'Shell only. Smallest footprint; the agent must do everything through it.',
    extraArgs: ['--available-tools=bash', '--disable-builtin-mcps'],
    measuredOverhead: 4068
  }
]

export const DEFAULT_TOOL_PROFILE = 'full'

/**
 * Built-in agent presets. ACP is agent-agnostic, so anything that speaks it
 * over stdio works here — Copilot is just the default.
 */
export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    args: ['--acp', '--stdio']
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude-code-acp',
    args: []
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp']
  }
]

export async function availableAgents(): Promise<AgentDefinition[]> {
  const checked = await Promise.all(
    BUILTIN_AGENTS.map(async (a) => ({ agent: a, bin: await which(a.command) }))
  )
  // Keep Copilot listed even if the probe fails so the UI can surface a real
  // error on launch rather than showing an empty agent list.
  return checked
    .filter(({ agent, bin }) => bin !== null || agent.id === 'copilot')
    .map(({ agent, bin }) => ({ ...agent, command: bin ?? agent.command }))
}

export async function resolveAgent(
  agentId: string,
  toolProfileId: string = DEFAULT_TOOL_PROFILE
): Promise<AgentDefinition> {
  const preset = BUILTIN_AGENTS.find((a) => a.id === agentId)
  if (!preset) throw new Error(`Unknown agent: ${agentId}`)
  const bin = await which(preset.command)
  if (!bin) {
    throw new Error(
      `Could not find "${preset.command}" on your PATH. Install it, or make sure it is on the PATH of your login shell.`
    )
  }

  // Tool-restriction flags are Copilot's. Applying them to another agent would
  // make it fail to launch on an unknown argument, so they are opt-in per agent.
  const profile = TOOL_PROFILES.find((p) => p.id === toolProfileId)
  const extraArgs =
    preset.id === 'copilot' && profile ? profile.extraArgs : []

  return {
    ...preset,
    command: bin,
    args: [...preset.args, ...extraArgs],
    toolProfile: profile?.id ?? DEFAULT_TOOL_PROFILE,
    env: { ...preset.env, PATH: await resolvedPath() }
  }
}

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

export async function resolveAgent(agentId: string): Promise<AgentDefinition> {
  const preset = BUILTIN_AGENTS.find((a) => a.id === agentId)
  if (!preset) throw new Error(`Unknown agent: ${agentId}`)
  const bin = await which(preset.command)
  if (!bin) {
    throw new Error(
      `Could not find "${preset.command}" on your PATH. Install it, or make sure it is on the PATH of your login shell.`
    )
  }
  return { ...preset, command: bin, env: { ...preset.env, PATH: await resolvedPath() } }
}

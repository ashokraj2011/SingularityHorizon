import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import type { AgentDefinition } from '../shared/ipc'
import { copilotProviderEnv, endpointEnv } from './llmEndpoints'

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
/**
 * Where the bundled harness lives.
 *
 * Resolved rather than assumed: `out/harness/index.mjs` next to the built main
 * process in production, and the same path from the repo root in dev. Getting
 * this wrong shows up as "agent not found" for the one agent that is always
 * installed, so both are tried.
 */
export function harnessEntry(): string {
  // `__dirname` exists in the CommonJS main-process bundle and not in an ESM
  // one, and `typeof` on an undeclared identifier is the one way to ask without
  // throwing in either. A headless harness bundling this module would otherwise
  // fail at import rather than at use.
  const here = typeof __dirname === 'string' ? __dirname : null
  const candidates = [
    ...(here ? [join(here, '..', 'harness', 'index.mjs')] : []),
    join(process.cwd(), 'out', 'harness', 'index.mjs')
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK)
      return candidate
    } catch {
      /* try the next one */
    }
  }
  return candidates[1]
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    // Event Horizon's own harness. No CLI to install, and it speaks ACP like
    // everything else — so the gate, the transcript and the workflow runtime
    // treat it exactly as they treat a third party's agent.
    //
    // Coding and chat are one agent with a mode toggle rather than two entries
    // in a list: which of them you want changes several times an hour, and
    // picking an agent starts a new session.
    id: 'built-in',
    name: 'Event Horizon',
    command: process.execPath,
    args: [],
    permissionModel: 'protocol'
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    args: ['--acp', '--stdio'],
    // Observed at 1.0.75: routes terminal and fs calls through
    // session/request_permission. Recorded, not trusted — the client gate runs
    // regardless, and this value is one upstream release away from being wrong.
    permissionModel: 'protocol'
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude-agent-acp',
    // The adapter has shipped under two names; probe both rather than showing
    // the agent as unavailable because we guessed the older one.
    altCommands: ['claude-code-acp'],
    args: [],
    permissionModel: 'unknown'
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex-acp',
    args: [],
    permissionModel: 'unknown'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    // The direct-LLM path: point its provider config at the model gateway and
    // anything the gateway fronts — including internal models — becomes a
    // coding agent here without a line of harness code.
    permissionModel: 'unknown'
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    args: ['acp'],
    permissionModel: 'unknown'
  }
  // Gemini CLI removed: the ACP entry point is being retired upstream.
]

/** First of the agent's candidate binaries that exists on PATH. */
async function whichAny(agent: AgentDefinition): Promise<string | null> {
  // The bundled harness ships with the app; there is nothing to look for.
  if (agent.id === 'built-in') return agent.command
  for (const candidate of [agent.command, ...(agent.altCommands ?? [])]) {
    const found = await which(candidate)
    if (found) return found
  }
  return null
}

export async function availableAgents(): Promise<AgentDefinition[]> {
  const checked = await Promise.all(
    BUILTIN_AGENTS.map(async (a) => ({ agent: a, bin: await whichAny(a) }))
  )
  // Keep Copilot listed even if the probe fails so the UI can surface a real
  // error on launch rather than showing an empty agent list.
  return checked
    .filter(({ agent, bin }) => bin !== null || agent.id === 'copilot')
    .map(({ agent, bin }) => ({ ...agent, command: bin ?? agent.command }))
}

export async function resolveAgent(
  agentId: string,
  toolProfileId: string = DEFAULT_TOOL_PROFILE,
  virtualKey?: string,
  endpointId?: string
): Promise<AgentDefinition> {
  const preset = BUILTIN_AGENTS.find((a) => a.id === agentId)
  if (!preset) throw new Error(`Unknown agent: ${agentId}`)
  const bin = await whichAny(preset)
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

  // The harness takes its entry point and its mode from us, not from a flag
  // the user could be expected to remember.
  const builtIn = preset.id === 'built-in'
  const harnessArgs = builtIn ? [harnessEntry()] : []
  // The configured endpoint decides where the harness talks and as what. An
  // endpoint's key is decrypted here and goes straight into the child's
  // environment; it is never returned to a caller that might render it.
  const harnessEnv: Record<string, string> = builtIn
    ? {
        // `process.execPath` is Electron's binary inside the app, not node —
        // spawning it with a script path makes Electron try to open the script
        // as an application and nothing happens. This flag is how the same
        // binary runs as plain Node, and it means a packaged app needs no Node
        // installed alongside it.
        //
        // Not catchable headlessly: in a test process execPath really is node,
        // so the harness starts and every assertion passes. It only shows up
        // when the app runs.
        ELECTRON_RUN_AS_NODE: '1',
        ...(await endpointEnv(endpointId))
      }
    : // Copilot can be pointed at the same gateway through its BYOK variables,
      // but only when an endpoint has explicitly opted in.
      preset.id === 'copilot'
      ? await copilotProviderEnv(endpointId)
      : {}

  return {
    ...preset,
    command: bin,
    args: [...harnessArgs, ...preset.args, ...extraArgs],
    toolProfile: profile?.id ?? DEFAULT_TOOL_PROFILE,
    env: { ...preset.env, PATH: await resolvedPath(), ...gatewayEnv(virtualKey), ...harnessEnv }
  }
}

/**
 * Point an agent at the model gateway.
 *
 * Agents that talk to a provider directly all read a base URL and an API key
 * from the environment, and every major one accepts the OpenAI-compatible pair
 * — which is what a LiteLLM proxy or an internal gateway speaks. Setting both
 * families means one gateway serves an OpenAI-flavoured agent and an
 * Anthropic-flavoured one without per-agent configuration.
 *
 * The key is passed in per session rather than read from the environment here,
 * so a workflow runtime can issue one virtual key per (thread, step) and have
 * spend attribute itself. With no gateway configured this returns nothing and
 * agents use their own credentials exactly as before.
 *
 * Standing up the proxy is an operational task, not this file's job.
 */
export function gatewayEnv(virtualKey?: string): Record<string, string> {
  const base = process.env.EVENT_HORIZON_GATEWAY_URL
  if (!base) return {}
  const key = virtualKey ?? process.env.EVENT_HORIZON_GATEWAY_KEY
  return {
    OPENAI_BASE_URL: base,
    ANTHROPIC_BASE_URL: base,
    ...(key ? { OPENAI_API_KEY: key, ANTHROPIC_API_KEY: key } : {})
  }
}

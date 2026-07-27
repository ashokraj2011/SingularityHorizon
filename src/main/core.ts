/**
 * The agent-side core, with no Electron dependency.
 *
 * Everything here is plain Node: it spawns the agent, speaks ACP over stdio,
 * serves the client half of the protocol (fs, terminals, permissions), and
 * loads skills and attachments. Electron appears nowhere in this graph — only
 * `src/main/index.ts` imports it, and that file is the desktop app's host
 * adapter, not part of the core.
 *
 * A CLI daemon, a local HTTP/WebSocket server, or a VS Code extension host can
 * therefore drive the same engine the desktop app uses.
 */
export { AgentSession } from './acp/session'
export { SessionManager } from './manager'
export { RpcPeer } from './acp/jsonrpc'
export { TerminalManager } from './acp/terminals'
export {
  readTextFile,
  writeTextFile,
  assertAllowed,
  PathNotAllowedError
} from './acp/workspaceFs'

export {
  BUILTIN_AGENTS,
  availableAgents,
  resolveAgent,
  resolvedPath,
  which
} from './agents'
export { listSkills, expandSkill } from './skills'
export { buildAttachments, statPaths } from './attachments'
export { discoverRepo, ensureAstIgnored } from './repo'

/**
 * In-process embedding API. A host Electron app calls these instead of
 * spawning a second process, so both share one runtime and one lifecycle.
 * Importing this module starts nothing — the host decides when.
 */
export {
  registerEventHorizonHandlers,
  openEventHorizonWindow,
  eventHorizonStatus,
  setHostContext,
  getHostContext,
  startStandalone,
  type OpenWindowOptions,
  type EventHorizonStatus
} from './app'
export { AstIndex, indexFor } from './ast/astIndex'
export { outlineFile, outlineSource, renderOutline, extractSymbol } from './ast/outline'

/**
 * The workflow extension point. Concrete providers are NOT exported here — a
 * host imports the one it wants from its own subpath under `providers/` and
 * registers it at startup. Core stays ignorant of every workflow system, which
 * is what lets the same build run standalone and embedded.
 */
export {
  registerProvider,
  registeredProviders,
  clearProviders,
  detectAll,
  collectContextDocuments,
  notifyPhaseEnter
} from './providers/registry'
export type { WorkspaceProvider } from './providers/types'

export type { BuiltAttachments } from './attachments'
export type { CreateTerminalParams } from './acp/terminals'

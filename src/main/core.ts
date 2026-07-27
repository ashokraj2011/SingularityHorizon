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

export type { BuiltAttachments } from './attachments'
export type { CreateTerminalParams } from './acp/terminals'

import type {
  AvailableCommand,
  ContentBlock,
  ModelInfo,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionModeState,
  StopReason,
  TokenUsage,
  ToolCall
} from './acp'

/* ------------------------------------------------------------ view model */

/**
 * A thread is a flat, ordered list of blocks. Streaming chunks are folded into
 * the trailing block of the same kind so the UI re-renders one node per token
 * burst instead of appending thousands of nodes.
 */
export type ThreadBlock =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number; streaming: boolean }
  | { id: string; kind: 'thought'; text: string; at: number; streaming: boolean }
  | { id: string; kind: 'tool'; call: ToolCall; at: number }
  | { id: string; kind: 'plan'; entries: PlanEntry[]; at: number }
  | { id: string; kind: 'permission'; request: PendingPermission; at: number }
  | { id: string; kind: 'notice'; level: 'info' | 'error'; text: string; at: number }

export interface PendingPermission {
  requestId: string
  sessionId: string
  toolCall: ToolCall
  options: PermissionOption[]
  /** Set once answered so the card renders its resolution instead of buttons. */
  resolvedOptionId?: string
  cancelled?: boolean
}

export type SessionStatus = 'starting' | 'idle' | 'busy' | 'error' | 'exited'

export interface SessionSummary {
  id: string
  /** ACP sessionId assigned by the agent; absent until session/new resolves. */
  acpSessionId?: string
  title: string
  cwd: string
  agentId: string
  status: SessionStatus
  createdAt: number
}

export interface SessionSnapshot extends SessionSummary {
  blocks: ThreadBlock[]
  models: ModelInfo[]
  modes?: SessionModeState
  configOptions: SessionConfigOption[]
  commands: AvailableCommand[]
  usage?: TokenUsage
  agentName?: string
  agentVersion?: string
  lastError?: string
}

/* ------------------------------------------------------------- agent def */

export interface AgentDefinition {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

/* --------------------------------------------------------------- events */

export type MainEvent =
  | { type: 'session:created'; session: SessionSnapshot }
  | { type: 'session:blocks'; sessionId: string; blocks: ThreadBlock[] }
  | { type: 'session:patch'; sessionId: string; patch: Partial<SessionSnapshot> }
  | { type: 'session:removed'; sessionId: string }
  | { type: 'session:turnEnded'; sessionId: string; stopReason: StopReason }

/* ------------------------------------------------------------- fs types */

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

/* ----------------------------------------------------------------- API */

export interface AcpStudioApi {
  listAgents(): Promise<AgentDefinition[]>
  listSessions(): Promise<SessionSnapshot[]>
  createSession(opts: { cwd: string; agentId: string }): Promise<SessionSnapshot>
  closeSession(sessionId: string): Promise<void>
  prompt(sessionId: string, content: ContentBlock[]): Promise<void>
  cancel(sessionId: string): Promise<void>
  respondPermission(requestId: string, optionId: string | null): Promise<void>
  setConfigOption(sessionId: string, optionId: string, value: string): Promise<void>
  pickDirectory(): Promise<string | null>
  readDir(dir: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  searchFiles(root: string, query: string): Promise<string[]>
  homeDir(): Promise<string>
  onEvent(listener: (event: MainEvent) => void): () => void
}

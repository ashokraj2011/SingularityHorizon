import type {
  AvailableCommand,
  ModelInfo,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionModeState,
  StopReason,
  ToolCall
} from './acp'
import type { ContextInfo, UsageInfo } from './contextInfo'

/* ------------------------------------------------------------ view model */

/**
 * A thread is a flat, ordered list of blocks. Streaming chunks are folded into
 * the trailing block of the same kind so the UI re-renders one node per token
 * burst instead of appending thousands of nodes.
 */
export type ThreadBlock =
  | {
      id: string
      kind: 'user'
      text: string
      at: number
      skill?: InvokedSkill
      attachments?: AttachmentSummary[]
    }
  | { id: string; kind: 'assistant'; text: string; at: number; streaming: boolean }
  | { id: string; kind: 'thought'; text: string; at: number; streaming: boolean }
  | { id: string; kind: 'tool'; call: ToolCall; at: number }
  | { id: string; kind: 'plan'; entries: PlanEntry[]; at: number }
  | { id: string; kind: 'permission'; request: PendingPermission; at: number }
  | { id: string; kind: 'notice'; level: 'info' | 'error'; text: string; at: number }

/* --------------------------------------------------------- attachments */

export interface AttachmentRef {
  path: string
  kind: 'file' | 'folder'
}

/** What actually got sent, recorded on the user block. */
export interface AttachmentSummary {
  path: string
  name: string
  kind: 'file' | 'folder'
  bytes?: number
  /** Set when the file exceeded the embed cap and was truncated. */
  truncated?: boolean
  /** Set for binary files, which are referenced by path instead of embedded. */
  binary?: boolean
  /** For folders: how many entries were listed. */
  entryCount?: number
  error?: string
}

/** A skill loaded from disk by this client, not advertised by the agent. */
export interface SkillInfo {
  name: string
  description: string
  argumentHint?: string
  /** 'repo' | 'user' | plugin directory name. */
  source: string
  path: string
}

/** Recorded on the user block so the transcript shows what was really sent. */
export interface InvokedSkill {
  name: string
  source: string
  /** Character count of the expanded instructions handed to the agent. */
  expandedChars: number
}

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
  /**
   * Parsed from `/context` and `/usage`. Copilot never emits ACP's
   * `usage_update`, so these are populated by running those commands silently
   * after each turn — see contextInfo.ts.
   */
  context?: ContextInfo
  usage?: UsageInfo
  agentName?: string
  agentVersion?: string
  lastError?: string
}

export interface PromptRequest {
  text: string
  /** Files and folders to attach as context; read in the main process. */
  attachments?: AttachmentRef[]
  /**
   * Shorter text to show in the transcript instead of `text`. A skill
   * invocation expands to a whole SKILL.md, which would bury the thread.
   */
  displayText?: string
  skill?: InvokedSkill
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
  /** Close a session and open a fresh one on the same cwd with the same agent. */
  restartSession(sessionId: string): Promise<SessionSnapshot | null>
  prompt(sessionId: string, request: PromptRequest): Promise<void>
  /**
   * Run a slash command and return its text without adding anything to the
   * transcript. Used for `/context` and `/usage`.
   */
  runCommandSilent(sessionId: string, command: string): Promise<string>
  refreshContext(sessionId: string): Promise<void>
  listSkills(cwd: string): Promise<SkillInfo[]>
  expandSkill(
    cwd: string,
    name: string,
    args: string
  ): Promise<{ text: string; skill: SkillInfo }>
  pickFiles(): Promise<string[]>
  statPaths(paths: string[]): Promise<AttachmentSummary[]>
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

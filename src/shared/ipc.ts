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

/**
 * `outline` sends a structural view — signatures with bodies stripped —
 * instead of the file. Measured 75–90% smaller on implementation-heavy source,
 * and unlike a grep excerpt it is guaranteed complete: every declaration is
 * present. Falls back to full content for languages the parser doesn't cover.
 */
export type AttachmentMode = 'full' | 'outline'

export interface AttachmentRef {
  path: string
  kind: 'file' | 'folder'
  mode?: AttachmentMode
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
  /** Which mode was actually used — may differ from what was asked for. */
  mode?: AttachmentMode
  /** True when outline was requested but the language isn't supported. */
  outlineUnavailable?: boolean
  /** Approximate tokens saved by outlining, for display. */
  savedChars?: number
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
  /** Tool profile the agent was spawned with; fixed for the session's life. */
  toolProfile?: string
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

/* ------------------------------------------------------------------ repo */

/**
 * The repo owns durable state (AST index, world model); the working directory
 * is where the agent actually runs, which may be a subdirectory of it.
 */
export interface RepoInfo {
  root: string
  workingDir: string
  relativeWorkingDir: string
  isGit: boolean
  /**
   * Anything a registered WorkspaceProvider had to say. Empty in the standalone
   * app, which knows nothing about any workflow system.
   */
  providers: ProviderStatus[]
}

/**
 * What a workflow integration reports about a repo. Deliberately generic: the
 * core renders these without understanding what any of them mean.
 */
export interface ProviderStatus {
  id: string
  name: string
  /** Whether the integration is usable here, not merely present. */
  ready: boolean
  version?: string
  /** Current lifecycle phase, when the provider tracks one. */
  phase?: string
  /** Short line for the UI, e.g. "WORK-142 · implementation". */
  summary?: string
  /** Anything provider-specific the host may want; core never inspects it. */
  detail?: Record<string, unknown>
}

/** A document a provider thinks should seed a session's context. */
export interface ContextDocument {
  /** Provider that supplied it. */
  providerId: string
  title: string
  /** Absolute path when it came from disk; absent for generated content. */
  path?: string
  text: string
  /** Why this is being injected, shown to the user before it is sent. */
  reason?: string
}

export interface AstIndexStats {
  files: number
  symbols: number
  /** Files re-parsed on the last refresh because they changed. */
  parsed: number
  /** Files served from cache. */
  reused: number
  removed: number
  durationMs: number
  builtAt?: number
}

export interface SymbolHit {
  name: string
  kind: string
  path: string
  line: number
  endLine: number
  exported: boolean
  container?: string
  signature: string
}

/* ------------------------------------------------------------- agent def */

export interface AgentDefinition {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Which tool profile produced `args`; set by resolveAgent. */
  toolProfile?: string
}

/**
 * A spawn-time tradeoff between agent capability and per-request context cost.
 * Tool definitions are re-sent on every request, so trimming them compounds.
 */
export interface ToolProfileInfo {
  id: string
  name: string
  description: string
  /** Measured fixed overhead in tokens — see src/main/agents.ts for method. */
  measuredOverhead?: number
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
  listToolProfiles(): Promise<ToolProfileInfo[]>
  createSession(opts: {
    cwd: string
    agentId: string
    toolProfile?: string
  }): Promise<SessionSnapshot>
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
  describeRepo(workingDir: string): Promise<RepoInfo>
  refreshAstIndex(repoRoot: string): Promise<AstIndexStats>
  rebuildAstIndex(repoRoot: string): Promise<AstIndexStats>
  searchSymbols(repoRoot: string, query: string): Promise<SymbolHit[]>
  attachSymbol(repoRoot: string, path: string, name: string): Promise<AttachmentSummary | null>
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

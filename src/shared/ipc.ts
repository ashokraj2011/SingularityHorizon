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
  /**
   * True when the client raised this card because the agent went ahead without
   * asking. Worth showing: it is the difference between an agent that follows
   * the protocol and one that merely got caught.
   */
  gated?: boolean
  /**
   * True when a governed workflow step answered this from its standing grant
   * rather than a person answering it. Recorded because "approved" and
   * "approved by nobody in particular" are different things in a receipt.
   */
  unattended?: boolean
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
  /** Provider context injected once with the first real user turn. */
  contextDocuments?: Array<Pick<ContextDocument, 'providerId' | 'title' | 'kind' | 'reason'>>
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

/* ------------------------------------------------------------ persistence */

/**
 * A session's durable record. The transcript lives beside this in a JSONL file
 * keyed by `id`; this is only what the session list needs to render without
 * reading every transcript.
 */
export interface PersistedSession {
  id: string
  title: string
  cwd: string
  agentId: string
  toolProfile?: string
  /** The agent's own session id, for resuming via ACP session/load. */
  acpSessionId?: string
  createdAt: number
  updatedAt: number
  /** Completed prompt turns, for the list. */
  turns: number
  /** First line of the last user message, as a label. */
  lastMessage?: string
  /** Last known token accounting, scraped from `/usage`. */
  usage?: UsageInfo
  /** Model in use when usage was last read. */
  model?: string
  /**
   * The agent's own cost multiplier for that model, e.g. "15x". Copilot bills
   * premium requests with a per-model multiplier rather than by token, so this
   * — not token count — is what moves the invoice.
   */
  modelMultiplier?: string
}

/** Cost and volume rolled up across sessions. */
export interface UsageBucket {
  key: string
  label: string
  sessions: number
  requests: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** Requests weighted by the model multiplier, when one is known. */
  weightedRequests: number
  multiplier?: string
}

export interface UsageSummary {
  totalSessions: number
  sessionsWithUsage: number
  totalRequests: number
  totalWeightedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  byModel: UsageBucket[]
  byRepo: UsageBucket[]
  byDay: UsageBucket[]
  /** True when some sessions have no usage reading, so totals understate. */
  partial: boolean
}

/**
 * The record of what an agent was allowed to do in a session.
 *
 * Derived from the transcript rather than logged separately, so it cannot drift
 * from what the user actually saw and approved.
 */
export interface AuditApproval {
  at: number
  title: string
  command?: string
  decision: string
}

export interface AuditCommand {
  at: number
  command: string
  status?: string
}

export interface AuditRecord {
  session: PersistedSession | null
  approvals: AuditApproval[]
  commands: AuditCommand[]
  blocks: number
}

/**
 * Administrative restrictions. Enforced in the main process; the renderer reads
 * this only to explain why a control is unavailable.
 */
export interface AdminPolicy {
  /** Force every session onto this tool profile, ignoring the picker. */
  pinToolProfile?: string
  /** Only these agents may be launched. */
  allowedAgents?: string[]
  /** Only these model ids may be selected. */
  allowedModels?: string[]
  /** Refuse "allow all" — every action must be approved individually. */
  disableAllowAll?: boolean
  /** Refuse autopilot mode, which approves everything by design. */
  disableAutopilot?: boolean
  /** Shown in the UI so people know where a restriction came from. */
  note?: string
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
/**
 * A durable unit of work a provider tracks — a story, a work item, a ticket.
 *
 * Event Horizon's own vocabulary, not any provider's. A provider maps whatever
 * its tool calls this into these fields; core never learns the tool's schema.
 * That direction matters: the moment core understands one workflow tool's
 * shape, every other tool becomes a special case of it.
 */
export interface WorkThread {
  id: string
  title: string
  /** Whatever the provider calls the current stage. Opaque to core. */
  phase?: string
  status?: 'active' | 'awaiting-approval' | 'blocked' | 'done'
  /** Absolute path this thread's work happens in. */
  cwd?: string
  /** Produced work, bound by content hash where the provider records one. */
  artifacts?: Array<{ path: string; sha256?: string; phase?: string }>
  /** Decisions already taken, so the UI can show what was agreed. */
  decisions?: Array<{ text: string; at?: number; by?: string }>
  /** What the provider says can happen next. Ids are passed back verbatim. */
  actions?: WorkThreadAction[]
  /** Provider-specific payload. Core never inspects it. */
  detail?: Record<string, unknown>
}

export interface WorkThreadAction {
  /** Opaque to core — handed straight back to the provider that offered it. */
  id: string
  label: string
  /** Whether running it changes anything the user would want to confirm. */
  effect: 'read-only' | 'mutates-repo' | 'mutates-remote'
  /** Set when the provider knows this action cannot run right now. */
  unavailable?: string
}

export interface ActionResult {
  ok: boolean
  /** Shown to the user verbatim. */
  message: string
  detail?: Record<string, unknown>
}

/**
 * What a provider can actually do here.
 *
 * Declared rather than discovered, so the UI can offer exactly what works
 * instead of rendering controls that fail on click. A provider that supports
 * nothing beyond detection is a perfectly good provider.
 */
export type ProviderCapability = 'contextDocuments' | 'workThreads' | 'actions'

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
  /** Instructions guide the agent; evidence remains untrusted reference material. */
  kind?: 'instructions' | 'evidence'
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

/**
 * A configured LLM gateway or API, as the renderer is allowed to see it.
 *
 * There is no key on this type, and that is deliberate rather than an omission:
 * the renderer gets `hasKey` and nothing more, so a secret cannot leak through
 * a devtools panel or a state dump.
 */
export interface LlmEndpoint {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  baseUrl: string
  models: string[]
  defaultModel?: string
  hasKey: boolean
  isDefault: boolean
  /**
   * Copilot's BYOK wire API. Only consulted when routing Copilot through this
   * endpoint; the built-in harness always speaks chat completions.
   */
  wireApi?: 'completions' | 'responses'
  /**
   * Route GitHub Copilot CLI through this endpoint too, via its BYOK
   * environment variables. Off by default and deliberately explicit: silently
   * redirecting Copilot away from GitHub's own routing would break a working
   * setup in a way nobody would think to look for.
   */
  useForCopilot?: boolean
}

export interface LlmEndpointInput {
  /** Absent when creating. */
  id?: string
  name: string
  provider: 'openai' | 'anthropic'
  baseUrl: string
  models: string[]
  defaultModel?: string
  wireApi?: 'completions' | 'responses'
  useForCopilot?: boolean
  /** Omit to leave a stored key untouched; empty string clears it. */
  apiKey?: string
}

/** What a client-enforced gate can be asked to permit. */
export type ToolClass = 'terminal' | 'fs.write' | 'fs.read'

/**
 * The capability lattice a session runs under. Cumulative and ordered:
 * discuss < explore < plan < edit < verify < deliver.
 *
 * Distinct from the agent's own mode (Agent / Plan / Autopilot), which the
 * agent advertises and enforces itself. This one is enforced by the client and
 * an agent cannot change it.
 */
export type SessionMode = 'discuss' | 'explore' | 'plan' | 'edit' | 'verify' | 'deliver'

/**
 * Whether an agent is known to route consequential calls through
 * `session/request_permission` before making them.
 *
 * 'protocol'    — observed asking before terminal/fs calls, at a pinned version
 * 'cooperative' — asks sometimes; unprompted calls must be treated as ungated
 * 'unknown'     — the default, including for anything the user adds
 *
 * This is a record of observed behaviour, not a promise. The gate does not
 * trust any of these values — it intercepts regardless. The field exists so the
 * UI can be honest about which agents were checked.
 */
export type PermissionModel = 'protocol' | 'cooperative' | 'unknown'

export interface AgentDefinition {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Which tool profile produced `args`; set by resolveAgent. */
  toolProfile?: string
  /** Observed permission behaviour. Never trusted — see PermissionModel. */
  permissionModel?: PermissionModel
  /** Other binary names to probe for the same agent. */
  altCommands?: string[]
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
  /**
   * Host-supplied context for a working directory. The value is opaque to
   * core — only the host's own UI slot knows how to read it.
   */
  | { type: 'host:context'; cwd: string; context: unknown }
  /** Focus this session — a host handed us its directory. */
  | { type: 'session:activate'; sessionId: string }

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
  /** Sessions on disk, including ones from previous runs. */
  listPersisted(): Promise<PersistedSession[]>
  /** Reopens a stored session: transcript from disk, agent reconnected. */
  restoreSession(id: string): Promise<SessionSnapshot | null>
  forgetSession(id: string): Promise<void>
  usageSummary(): Promise<UsageSummary>
  /** Policy in force for a working directory (omit for the global default). */
  getAdminPolicy(workingDir?: string): Promise<AdminPolicy>

  /** Records the theme in effect, so the next launch fills the window to match. */
  rememberTheme(theme: 'dark' | 'light'): Promise<void>

  listEndpoints(): Promise<LlmEndpoint[]>
  saveEndpoint(input: LlmEndpointInput): Promise<{ endpoint: LlmEndpoint; warning?: string }>
  deleteEndpoint(id: string): Promise<void>
  setDefaultEndpoint(id: string): Promise<void>
  testEndpoint(id: string): Promise<{ ok: boolean; message: string }>
  exportAudit(id: string): Promise<AuditRecord>
  /** Writes an audit record to a file the user chooses. Returns the path. */
  saveAudit(id: string, format: 'json' | 'markdown'): Promise<string | null>
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
  preferredToolProfile(repoRoot?: string): Promise<string | undefined>
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
